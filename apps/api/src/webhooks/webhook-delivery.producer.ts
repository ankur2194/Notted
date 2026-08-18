// Part 66 — transaction-scoped producer for the `webhook.deliver` intent.
//
// Called from inside the note, project and membership mutation transactions,
// exactly like `NoteSearchIndexProducer.scheduleSearchSync` and
// `ExportJobProducer.scheduleExportGeneration`: ADR 0006 requires the durable
// intent to commit atomically with the mutation it describes, with dispatch
// happening only after commit. A webhook committed outside the transaction
// would announce a note update that a rollback then un-did.
//
// THE EVENT FILTER LIVES HERE, NOT AT THE CALL SITES. `NOTE_DOMAIN_EVENTS`
// alone carries nine names (`note.moved`, `folder.created`, …) and only five
// event names in the whole product are subscribable. Filtering here is what
// lets every call site be a single unconditional line that never has to know
// which subset a receiver may ask for — and what guarantees the catalog can
// only ever grow in ONE place (`WEBHOOK_EVENTS`).
//
// FAN-OUT IS ONE ROW PER ENDPOINT. A workspace with four subscribed endpoints
// commits four independent intents for one note update, so a single dead
// receiver retries on its own budget without holding up the other three.
//
// THE PAYLOAD IS IDENTIFIERS ONLY (ADR 0006), WITH ONE ARGUED EXCEPTION:
// `occurredAt`. A deletion's timestamp is not recoverable from the row
// afterwards — by the time the handler runs, the deleted thing is gone or
// tombstoned, and `now()` at delivery time would misreport when the event
// happened to every receiver. It is schema-validated by
// `WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema` and covered by `payload_hash`,
// so a tampered value fails before the handler sees it. Nothing else readable
// travels: no title, no content, no URL, no secret. The handler re-reads the
// endpoint and the resource from PostgreSQL and re-authorizes the endpoint's
// creator against them.

import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { WEBHOOK_EVENTS, type WebhookEvent } from "@notted/shared-types";
import { and, eq, sql } from "drizzle-orm";

import { jobOutbox, webhooks, type JobOutboxPayload } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  WEBHOOK_DELIVER_JOB_DEFINITION,
  WEBHOOK_DELIVER_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { activeWorkspaceId, TenantContextService, whereWorkspace } from "../tenant";

import type { DatabaseTransaction } from "../database/database.service";

/** Shared prefix for every webhook delivery intent, for operator legibility. */
export const WEBHOOK_DELIVER_IDEMPOTENCY_PREFIX = "webhook-deliver:";

/**
 * The ORIGINAL intent's identity: one delivery of one event to one endpoint.
 *
 * `eventId` equals the original `intentId`, so this key is naturally
 * exactly-once without hashing anything: two intents can only collide when the
 * SAME (endpoint, event) pair is scheduled twice — a retried transaction — and
 * that is precisely the case `onConflictDoNothing` must swallow.
 */
export function webhookDeliverIdempotencyKey(webhookId: string, eventId: string): string {
  return `${WEBHOOK_DELIVER_IDEMPOTENCY_PREFIX}${webhookId}:${eventId}`;
}

/**
 * THE RETRY KEY IS DELIBERATELY DIFFERENT FROM THE ORIGINAL, AND THIS IS THE
 * MOST CONFUSING PART OF THE DESIGN, SO: read this before changing either.
 *
 * A manual admin replay carries the SAME `eventId` as the delivery it replays —
 * that is what keeps `X-Notted-Event-Id` stable across attempts AND across
 * replays, what lets a receiver dedupe, and what lets the replay path rebuild
 * the AUTHORITATIVE body from `job_outbox WHERE id = <eventId>` instead of
 * trusting a stored copy.
 *
 * If a replay reused `webhookDeliverIdempotencyKey`, it would collide with the
 * original intent's row and `onConflictDoNothing` would swallow it: the FIRST
 * replay would silently do nothing, and an admin clicking "retry" would get a
 * success answer with no delivery. So the replay mints a fresh `intentId` and
 * puts it IN the key. That makes a replay repeatable on purpose (an admin may
 * replay the same event more than once, e.g. after fixing their receiver),
 * while `onConflictDoNothing` still collapses a RETRIED TRANSACTION of one
 * replay — the only collision that key can now produce.
 */
export function webhookRetryIdempotencyKey(
  webhookId: string,
  eventId: string,
  intentId: string,
): string {
  return `${WEBHOOK_DELIVER_IDEMPOTENCY_PREFIX}retry:${webhookId}:${eventId}:${intentId}`;
}

/**
 * Identifier-only payload (plus the argued `occurredAt`). Declared standalone
 * rather than as `JobOutboxPayload & {...}`: the shared jsonb type predates
 * nullable payload fields (`actorId?: string`), and an intersection would
 * collapse `string | null` back to `string`.
 */
export interface WebhookDeliverPayload {
  readonly action: typeof DOMAIN_JOB_TYPES.webhookDeliver;
  readonly intentId: string;
  readonly workspaceId: string;
  readonly webhookId: string;
  /** Stable across every attempt AND across a manual replay of this event. */
  readonly eventId: string;
  readonly event: string;
  readonly resourceId: string | null;
  readonly actorId: string | null;
  readonly occurredAt: string;
}

export interface ScheduleWebhookDeliveriesInput {
  /** A domain event name. Non-subscribable names are filtered here. */
  readonly event: string;
  readonly workspaceId: string;
  readonly resourceId: string | null;
  readonly actorId: string | null;
  readonly occurredAt: Date;
  readonly correlationId?: string | null;
}

export interface ScheduleWebhookReplayInput {
  readonly webhookId: string;
  readonly eventId: string;
  /** The ORIGINAL intent's payload, re-read and re-validated by the service. */
  readonly payload: WebhookDeliverPayload;
  readonly correlationId?: string | null;
}

@Injectable()
export class WebhookDeliveryProducer {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Schedule one `webhook.deliver` intent per subscribed, enabled, verified
   * endpoint inside `tx`. The caller MUST pass the transaction that performed
   * the mutation being announced.
   */
  async scheduleWebhookDeliveries(
    tx: DatabaseTransaction,
    input: ScheduleWebhookDeliveriesInput,
  ): Promise<void> {
    // The cheap in-memory gate runs BEFORE any SQL: most mutations emit an
    // event nobody can subscribe to, and those must cost nothing at all.
    if (!WEBHOOK_EVENTS.includes(input.event as WebhookEvent)) return;

    // ponytail: per-mutation SELECT on a tiny table; add a per-workspace event→endpoint cache invalidated on webhook write if a profile ever shows it.
    const endpoints = await tx
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          whereWorkspace(webhooks, this.tenantContext),
          eq(webhooks.isEnabled, true),
          eq(webhooks.isVerified, true),
          // BOUND PARAMETER, NEVER INTERPOLATED. `input.event` is already proven
          // to be a member of a frozen literal array two lines up, so this is
          // not today's injection — it is the shape a later careless caller
          // turns into one, and `sql` templating a JS value emits `$n`.
          sql`${webhooks.events} @> ${JSON.stringify([input.event])}::jsonb`,
        ),
      );
    // The normal case: one index scan on a tiny table inside an already-open
    // transaction, then nothing.
    if (endpoints.length === 0) return;

    const occurredAt = input.occurredAt.toISOString();
    for (const endpoint of endpoints) {
      // THE FIRST INTENT'S `eventId` IS ITS OWN `intentId`. That single identity
      // is what every later attempt and every replay of this event carries.
      const intentId = randomUUID();
      const payload: WebhookDeliverPayload = Object.freeze({
        action: DOMAIN_JOB_TYPES.webhookDeliver,
        intentId,
        workspaceId: input.workspaceId,
        webhookId: endpoint.id,
        eventId: intentId,
        event: input.event,
        resourceId: input.resourceId,
        actorId: input.actorId,
        occurredAt,
      });
      await this.insertIntent(tx, {
        intentId,
        payload,
        idempotencyKey: webhookDeliverIdempotencyKey(endpoint.id, intentId),
        correlationId: input.correlationId ?? null,
      });
    }
  }

  /**
   * Schedule a MANUAL REPLAY of an already-delivered event. Returns whether a
   * fresh intent was written; `false` means a retried transaction lost the
   * `onConflictDoNothing` race, not that the replay was refused.
   */
  async scheduleWebhookReplay(
    tx: DatabaseTransaction,
    input: ScheduleWebhookReplayInput,
  ): Promise<boolean> {
    const intentId = randomUUID();
    // Same `eventId`, new `intentId`. Spreading keeps the original key order,
    // so the payload the handler validates is byte-identical apart from the
    // one field that identifies THIS attempt.
    const payload: WebhookDeliverPayload = Object.freeze({ ...input.payload, intentId });
    const inserted = await this.insertIntent(tx, {
      intentId,
      payload,
      idempotencyKey: webhookRetryIdempotencyKey(input.webhookId, input.eventId, intentId),
      correlationId: input.correlationId ?? null,
    });
    return inserted.length === 1;
  }

  private insertIntent(
    tx: DatabaseTransaction,
    row: {
      readonly intentId: string;
      readonly payload: WebhookDeliverPayload;
      readonly idempotencyKey: string;
      readonly correlationId: string | null;
    },
  ): Promise<{ readonly id: string }[]> {
    return (
      tx
        .insert(jobOutbox)
        .values({
          id: row.intentId,
          // Read from the active tenant context, not from the argument: the
          // caller has already proved the two agree, and taking it from here
          // keeps the outbox row scoped by the server-side value.
          workspaceId: activeWorkspaceId(this.tenantContext),
          queueName: WEBHOOK_DELIVER_SOURCE_QUEUE_NAME,
          jobType: DOMAIN_JOB_TYPES.webhookDeliver,
          payloadVersion: WEBHOOK_DELIVER_JOB_DEFINITION.payloadVersion,
          // `job_outbox.payload` is typed `JobOutboxPayload`, whose optional
          // `actorId?: string` predates events with no acting user.
          // `WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema` is the authoritative
          // contract for this job type (and is asserted in the tests); this
          // assertion only reconciles `string | null` with the older jsonb type.
          payload: row.payload as unknown as JobOutboxPayload,
          payloadHash: createHash("sha256").update(JSON.stringify(row.payload)).digest("hex"),
          idempotencyKey: row.idempotencyKey,
          correlationId: row.correlationId,
        })
        // The globally unique idempotency index turns a retried transaction into
        // a silent no-op instead of aborting the mutation being announced.
        .onConflictDoNothing()
        .returning({ id: jobOutbox.id })
    );
  }
}
