// Part 66 — consumer for the `webhook.deliver` intent.
//
// WHY DELIVERY LIVES HERE AND NOT IN THE REQUEST: an outbound HTTP call to an
// address a workspace admin typed is unbounded work whose latency belongs to a
// stranger. ADR 0006 is explicit that the durable INTENT commits with the
// business mutation while the SIDE EFFECT happens after commit. The producer
// writes the intent inside the note/project/membership transaction; this
// handler is the only thing that ever opens a socket for a subscribed event.
//
// THE PAYLOAD GRANTS NOTHING. It carries identifiers plus `occurredAt`, and
// every fact acted on here — the endpoint, its secret, its creator, the
// resource's own fields — is re-read from PostgreSQL now. A tampered or stale
// payload therefore cannot redirect a delivery, widen it, or smuggle content.
//
// AUTHORIZATION IS SERVER-LOADED, TWICE, FOR TWO DIFFERENT SUBJECTS:
//  1. A SYSTEM authority with a FINITE capability set (`workspace.read` on
//     `workspace`, never a wildcard) opens the tenant context the endpoint and
//     delivery-log bookkeeping needs. It deliberately cannot read a note.
//  2. THE ENDPOINT'S CREATOR is re-authorized against the LIVE resource with
//     `authorizeUserJob`. A workspace membership check is NOT what `note.read`
//     means — a restricted project's notes are readable only by project
//     members — so an endpoint created by someone who has since lost access to
//     a restricted project stops receiving that project's notes, without anyone
//     having to remember to disable it.
//
// FAILURE PHILOSOPHY — NOTHING DEAD-LETTERS FOR AN ORDINARY BAD RECEIVER.
// A 404 from the receiver, a disabled endpoint, a deleted resource, a creator
// who lost access, a URL the guard now refuses: each is a CLEAN job outcome
// recorded as one immutable `webhook_deliveries` row. Even the FINAL failed
// attempt of a retryable failure returns normally rather than throwing, because
// re-throwing on the last attempt would push a stranger's broken server into
// the platform dead-letter queue. The DLQ stays reserved for platform faults,
// exactly as in `export.worker.service.ts`; only a genuinely broken envelope
// throws, and it throws permanently.
//
// AT-LEAST-ONCE IS THE CONTRACT. The attempt row is written AFTER the HTTP
// call, so a crash between the receiver's 200 and that insert re-delivers on
// retry. That is why `X-Notted-Event-Id` is stable across attempts and replays:
// deduping is the receiver's job, and we give them the key to do it with.
//
// WHAT IS NEVER LOGGED: the endpoint URL (admin-supplied, and routinely
// carrying a bearer token in its path or query), the signature header, the
// signed body, and the secret. Every log line here is identifiers, an outcome
// and a duration.

import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";
import { DatabaseService } from "../database/database.service";
import { notes, projects, webhookDeliveries, webhooks, workspaceMembers } from "../database/schema";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { WEBHOOK_DELIVER_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { TenantContextService, whereWorkspace } from "../tenant";

import { WebhookSecretService } from "./webhook-secret.service";
import { sendWebhook, type WebhookSendResult } from "./webhook-sender";
import { signatureHeader, webhookBody } from "./webhook-signature";
import { WEBHOOK_USER_AGENT } from "./webhooks.constants";
import { webhookGuardOptions } from "./webhooks.service";

import type {
  AuthorizationAction,
  ResourceLocator,
} from "../authorization/authorization.contracts";
import type { WebhookDeliveryErrorCode, WebhookDeliveryStatus } from "@notted/shared-types";
import type { z } from "zod";

type WebhookDeliverContext = QueueJobContext<
  typeof WEBHOOK_DELIVER_JOB_DEFINITION.jobType,
  z.output<typeof WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema>
>;

/** A settled attempt, before the last-attempt downgrade is applied. */
interface DeliveryOutcome {
  readonly status: WebhookDeliveryStatus;
  readonly errorCode: WebhookDeliveryErrorCode | null;
}

/**
 * THE CLASSIFICATION TABLE. It matches `webhook-sender.ts`'s documented
 * behaviour exactly — in particular the sender NEVER reports
 * `response_too_large`: an oversized body is still a `response` outcome with a
 * capped or null snippet, because a 200 is a successful delivery however chatty
 * the receiver is.
 *
 *   2xx                                   -> success
 *   5xx, 408, 429                         -> retrying
 *   timeout / connection / DNS / TLS      -> retrying
 *   every other 4xx, and 3xx (we never
 *     follow a redirect, so it is data)   -> failed
 *   url_rejected (the guard refused)      -> failed
 */
function classify(result: WebhookSendResult): DeliveryOutcome {
  if (result.outcome === "error") {
    // A URL the guard refuses will be refused identically on every retry, so
    // spending four more attempts on it buys nothing.
    return result.errorCode === "url_rejected"
      ? { status: "failed", errorCode: "url_rejected" }
      : { status: "retrying", errorCode: result.errorCode };
  }
  if (result.status >= 200 && result.status < 300) return { status: "success", errorCode: null };
  const retryable = result.status >= 500 || result.status === 408 || result.status === 429;
  return { status: retryable ? "retrying" : "failed", errorCode: "http_error" };
}

/**
 * The re-authorization arm for each subscribable event.
 *
 * `null` means the event cannot name a live resource (a hand-inserted or
 * migrated intent), which is recorded as `resource_unavailable` rather than
 * delivered on nobody's authority. The action names are the ones that already
 * exist in `AUTHORIZATION_ACTIONS`; `member.joined` authorizes `member.list`
 * against the workspace because that is what "may this person see who is in
 * this workspace" means here — there is no per-membership read action.
 */
function authorizationTarget(
  event: string,
  resourceId: string | null,
): { readonly action: AuthorizationAction; readonly resource: ResourceLocator } | null {
  if (event === "member.joined") return { action: "member.list", resource: { kind: "workspace" } };
  if (resourceId === null) return null;
  if (event.startsWith("note.")) {
    return { action: "note.read", resource: { kind: "note", id: resourceId } };
  }
  if (event === "project.created") {
    return { action: "project.read", resource: { kind: "project", id: resourceId } };
  }
  return null;
}

@Injectable()
export class WebhookDeliveryWorkerService implements OnModuleInit, OnModuleDestroy {
  readonly jobType = WEBHOOK_DELIVER_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly secrets: WebhookSecretService,
    private readonly registry: QueueHandlerRegistry,
    private readonly logger: StructuredLogger,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(SECURITY_CONFIG) private readonly securityConfig: SecurityConfig,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: WEBHOOK_DELIVER_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: WebhookDeliverContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    const { workspaceId } = context.payload;

    // A FINITE system authority, never a wildcard. It exists only to open the
    // tenant context the endpoint read and the delivery-log write require; it
    // deliberately cannot read a note. The endpoint's creator does that below.
    const operation = await this.authorization.authorizeSystem({
      actor: {
        kind: "system",
        authorityId: "webhook-delivery-worker",
        workspaceId,
        purpose: "deliver a subscribed workspace event to a webhook endpoint",
        allowedActions: ["workspace.read"],
        allowedResourceKinds: ["workspace"],
      },
      action: "workspace.read",
      resource: { kind: "workspace" },
      correlationId: context.correlationId,
    });
    await this.authorization.run(operation, () => this.deliver(context));
  }

  private async deliver(context: WebhookDeliverContext): Promise<void> {
    const { workspaceId, webhookId, eventId, event, resourceId, actorId, occurredAt } =
      context.payload;

    const [endpoint] = await this.database.db
      .select({
        id: webhooks.id,
        url: webhooks.url,
        createdById: webhooks.createdById,
        encryptedSecret: webhooks.encryptedSecret,
        encryptionKeyVersion: webhooks.encryptionKeyVersion,
        isEnabled: webhooks.isEnabled,
        isVerified: webhooks.isVerified,
      })
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), whereWorkspace(webhooks, this.tenantContext)))
      .limit(1);
    // Deleted, disabled or un-verified between the intent and this attempt.
    // Every one of those is ordinary admin behaviour, not an incident, so it is
    // recorded and finished — never thrown.
    if (endpoint === undefined || !endpoint.isEnabled || !endpoint.isVerified) {
      await this.record(context, { status: "failed", errorCode: "resource_unavailable" }, null);
      return;
    }

    const target = authorizationTarget(event, resourceId);
    if (target === null) {
      await this.record(context, { status: "failed", errorCode: "resource_unavailable" }, null);
      return;
    }

    // RE-AUTHORIZE THE ENDPOINT'S CREATOR AGAINST THE LIVE RESOURCE. This is
    // what stops a restricted-project note reaching an endpoint whose creator
    // cannot read it. A denial is a clean outcome: retrying never changes it.
    try {
      await this.authorization.authorizeUserJob({
        userId: endpoint.createdById,
        workspaceId,
        action: target.action,
        resource: target.resource,
        correlationId: context.correlationId,
      });
    } catch (error: unknown) {
      if (error instanceof AuthorizationDeniedError) {
        await this.record(context, { status: "failed", errorCode: "resource_forbidden" }, null);
        return;
      }
      throw error;
    }

    const data = await this.resourceData(event, resourceId);
    if (data === null) {
      await this.record(context, { status: "failed", errorCode: "resource_unavailable" }, null);
      return;
    }

    let secret: string;
    try {
      secret = this.secrets.decrypt(
        endpoint.id,
        endpoint.encryptedSecret,
        endpoint.encryptionKeyVersion,
      );
    } catch {
      // An operator problem (a key dropped from `DATA_ENCRYPTION_KEYS`) or a
      // corrupt row. Either way there is no signature to send, and the cause is
      // deliberately not carried: it can quote the ciphertext.
      await this.record(context, { status: "failed", errorCode: "secret_unavailable" }, null);
      return;
    }

    // SERIALIZED ONCE. This exact string is what gets signed and what gets
    // written to the socket; re-stringifying it anywhere below would silently
    // invalidate every receiver's signature check.
    const body = webhookBody({ id: eventId, event, occurredAt, workspaceId, actorId, data });
    const timestampSeconds = Math.floor(Date.now() / 1_000);
    // A FRESH id per attempt, minted before the send so the receiver's
    // `X-Notted-Delivery-Id` and our stored row are the same value.
    const deliveryId = randomUUID();

    const result = await sendWebhook({
      url: endpoint.url,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        "x-notted-event": event,
        // Stable across every attempt AND across a manual replay: the receiver's
        // dedupe key.
        "x-notted-event-id": eventId,
        "x-notted-delivery-id": deliveryId,
        "x-notted-timestamp": timestampSeconds.toString(),
        "x-notted-signature": signatureHeader(secret, timestampSeconds, body),
      },
      timeoutMs: this.securityConfig.webhookRequestTimeoutMs,
      guard: webhookGuardOptions(this.appConfig, this.securityConfig),
      signal: context.signal,
    });

    const classified = classify(result);
    // THE LAST-ATTEMPT DOWNGRADE. Re-throwing here would dead-letter a
    // stranger's broken server; recording `failed` and returning settles the
    // job cleanly with the outcome an admin needs to see in the delivery log.
    const exhausted =
      classified.status === "retrying" && context.attempt >= context.maximumAttempts;
    const outcome: DeliveryOutcome = exhausted
      ? { status: "failed", errorCode: classified.errorCode }
      : classified;

    await this.record(context, outcome, {
      deliveryId,
      payloadHash: createHash("sha256").update(body).digest("hex"),
      responseStatus: result.outcome === "response" ? result.status : null,
      responseBodySnippet: result.outcome === "response" ? result.snippet : null,
      durationMs: result.durationMs,
    });

    const log = {
      ...this.logContext(context),
      status: outcome.status,
      durationMs: result.durationMs,
    };
    if (outcome.status === "success") {
      this.logger.info(log, "Webhook delivered");
    } else {
      this.logger.failure(
        { ...log, errorCode: outcome.errorCode ?? "unknown" },
        "Webhook delivery attempt did not succeed",
      );
    }

    // The ONLY throw on the delivery path, and only while attempts remain: it
    // is what asks BullMQ for the next bounded, jittered backoff.
    if (outcome.status === "retrying") throw new Error("Webhook delivery attempt failed");
  }

  /**
   * IDENTIFIERS AND CHEAP METADATA ONLY — never note content, never an email
   * address, never a person's name. ADR 0007: "never include data outside the
   * endpoint's scopes", and the safest reading of that is that a webhook body
   * says WHAT changed, not what it says.
   *
   * Each `data` object is a fixed literal because its KEY ORDER is part of the
   * signed body: reordering these properties changes the bytes and invalidates
   * every receiver's signature check with no error on our side.
   */
  private async resourceData(
    event: string,
    resourceId: string | null,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    if (resourceId === null) return null;

    if (event.startsWith("note.")) {
      const [note] = await this.database.db
        .select({
          id: notes.id,
          title: notes.title,
          projectId: notes.projectId,
          folderId: notes.folderId,
          parentId: notes.parentId,
          isArchived: notes.isArchived,
          isDeleted: notes.isDeleted,
          updatedAt: notes.updatedAt,
        })
        .from(notes)
        .where(and(eq(notes.id, resourceId), whereWorkspace(notes, this.tenantContext)))
        .limit(1);
      if (note === undefined) return null;
      return Object.freeze({
        id: note.id,
        // The title is the one human-readable field, and it is what makes a
        // delivery legible at all. The body is never sent.
        title: note.title,
        projectId: note.projectId,
        folderId: note.folderId,
        parentId: note.parentId,
        isArchived: note.isArchived,
        isDeleted: note.isDeleted,
        updatedAt: note.updatedAt.toISOString(),
      });
    }

    if (event === "project.created") {
      const [project] = await this.database.db
        .select({
          id: projects.id,
          name: projects.name,
          status: projects.status,
          isArchived: projects.isArchived,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(and(eq(projects.id, resourceId), whereWorkspace(projects, this.tenantContext)))
        .limit(1);
      if (project === undefined) return null;
      return Object.freeze({
        id: project.id,
        name: project.name,
        status: project.status,
        isArchived: project.isArchived,
        updatedAt: project.updatedAt.toISOString(),
      });
    }

    if (event === "member.joined") {
      const [member] = await this.database.db
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.id, resourceId),
            whereWorkspace(workspaceMembers, this.tenantContext),
          ),
        )
        .limit(1);
      if (member === undefined) return null;
      // NO NAME, NO EMAIL. A receiver gets the membership and user identifiers
      // and can ask the API for anything more on its own authority.
      return Object.freeze({
        membershipId: member.id,
        userId: member.userId,
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
      });
    }

    return null;
  }

  /**
   * EXACTLY ONE ROW PER ATTEMPT, written after the HTTP call with its terminal
   * status. There is no `pending` row and no conditional UPDATE: the schema
   * comment already declares attempts immutable, and a two-phase write would
   * need a state machine to answer a question a single insert answers by
   * construction.
   */
  private async record(
    context: WebhookDeliverContext,
    outcome: DeliveryOutcome,
    sent: {
      readonly deliveryId: string;
      readonly payloadHash: string;
      readonly responseStatus: number | null;
      readonly responseBodySnippet: string | null;
      readonly durationMs: number;
    } | null,
  ): Promise<void> {
    await this.database.db.insert(webhookDeliveries).values({
      id: sent?.deliveryId ?? randomUUID(),
      webhookId: context.payload.webhookId,
      eventId: context.payload.eventId,
      event: context.payload.event,
      status: outcome.status,
      attempt: context.attempt,
      responseStatus: sent?.responseStatus ?? null,
      responseBodySnippet: sent?.responseBodySnippet ?? null,
      // THE CLOSED CODE SET ONLY. Node's `error.message` quotes the endpoint
      // URL, which is admin-supplied and routinely carries a bearer token.
      errorMessage: outcome.errorCode,
      payloadHash: sent?.payloadHash ?? null,
      deliveredAt: sent === null ? null : new Date(),
    });

    if (sent !== null) return;
    // Pre-send refusals never reach the logging in `deliver`, so they get their
    // own line: an admin whose endpoint silently stopped firing needs to see
    // "your creator lost access", not nothing at all.
    this.logger.failure(
      {
        ...this.logContext(context),
        status: outcome.status,
        errorCode: outcome.errorCode ?? "unknown",
      },
      "Webhook delivery was refused before any request was made",
    );
  }

  /** Identifiers and an outcome. NEVER the URL, the signature, or the body. */
  private logContext(context: WebhookDeliverContext): Readonly<Record<string, string | number>> {
    return {
      jobType: this.jobType,
      workspaceId: context.payload.workspaceId,
      webhookId: context.payload.webhookId,
      eventId: context.payload.eventId,
      event: context.payload.event,
      attempt: context.attempt,
    };
  }
}
