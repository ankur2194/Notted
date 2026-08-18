import { createHash } from "node:crypto";

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { jobOutbox } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  WEBHOOK_DELIVER_JOB_DEFINITION,
  WEBHOOK_DELIVER_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { createTenantContext, TenantContextService } from "../tenant";

import { WebhookDeliveryProducer, type WebhookDeliverPayload } from "./webhook-delivery.producer";

import type { DatabaseTransaction } from "../database/database.service";
import type { SQL } from "drizzle-orm";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const NOTE_ID = "22222222-0000-4000-8000-000000000002";
const ACTOR_ID = "33333333-0000-4000-8000-000000000003";
const REQUEST_ID = "44444444-0000-4000-8000-000000000004";
const OCCURRED_AT = new Date("2026-08-18T09:30:00.000Z");

const dialect = new PgDialect();

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

interface FakeTx {
  readonly tx: DatabaseTransaction;
  readonly inserts: InsertedRow[];
  /** Every endpoint lookup issued; must stay at 0 for a non-subscribable event. */
  readonly selects: { readonly predicate: unknown }[];
}

/**
 * Records `insert(...).values(...).onConflictDoNothing().returning()` and
 * answers the single endpoint `select(...)` from a fixed id list. No database
 * involved; the producer touches nothing else on the transaction.
 */
function fakeTx(endpointIds: readonly string[], conflicts = false): FakeTx {
  const inserts: InsertedRow[] = [];
  const selects: { readonly predicate: unknown }[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => {
          selects.push({ predicate });
          return Promise.resolve(endpointIds.map((id) => ({ id })));
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(conflicts ? [] : [{ id: values.id }]),
          }),
        };
      },
    }),
  };
  return { tx: tx as unknown as DatabaseTransaction, inserts, selects };
}

function runInTenant<T>(fn: (producer: WebhookDeliveryProducer) => Promise<T>): Promise<T> {
  const tenant = new TenantContextService();
  const producer = new WebhookDeliveryProducer(tenant);
  return tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: ACTOR_ID }), () =>
    fn(producer),
  );
}

const payloadOf = (row: InsertedRow): WebhookDeliverPayload =>
  row.values.payload as WebhookDeliverPayload;

describe("WebhookDeliveryProducer", () => {
  it("filters a non-subscribable event before issuing any SQL", async () => {
    const fake = fakeTx(["55555555-0000-4000-8000-000000000005"]);
    await runInTenant((producer) =>
      producer.scheduleWebhookDeliveries(fake.tx, {
        // Emitted by `NotesService.recordMutation`, subscribable by nobody.
        event: "note.moved",
        workspaceId: WORKSPACE_ID,
        resourceId: NOTE_ID,
        actorId: ACTOR_ID,
        occurredAt: OCCURRED_AT,
      }),
    );
    expect(fake.inserts).toHaveLength(0);
    // The gate runs BEFORE the endpoint lookup — this is every note mutation's
    // hot path, so an unsubscribable event must cost no round trip at all.
    expect(fake.selects).toHaveLength(0);
  });

  it("issues one scoped lookup and inserts nothing when no endpoint subscribes", async () => {
    const fake = fakeTx([]);
    await runInTenant((producer) =>
      producer.scheduleWebhookDeliveries(fake.tx, {
        event: "note.created",
        workspaceId: WORKSPACE_ID,
        resourceId: NOTE_ID,
        actorId: ACTOR_ID,
        occurredAt: OCCURRED_AT,
      }),
    );
    expect(fake.selects).toHaveLength(1);
    expect(fake.inserts).toHaveLength(0);
  });

  it("scopes the lookup to the workspace and binds the jsonb operand", async () => {
    const fake = fakeTx([]);
    await runInTenant((producer) =>
      producer.scheduleWebhookDeliveries(fake.tx, {
        event: "note.created",
        workspaceId: WORKSPACE_ID,
        resourceId: NOTE_ID,
        actorId: ACTOR_ID,
        occurredAt: OCCURRED_AT,
      }),
    );
    const rendered = dialect.sqlToQuery(fake.selects[0]?.predicate as SQL);
    expect(rendered.params).toContain(WORKSPACE_ID);
    // THE POINT OF THIS ASSERTION: the containment operand must arrive as a
    // bound parameter. An interpolated jsonb literal would put the event name
    // in `rendered.sql` instead, which is the shape a later careless caller
    // turns into an injection.
    expect(rendered.params).toContain('["note.created"]');
    expect(rendered.sql).not.toContain('["note.created"]');
    expect(rendered.sql).toContain("@>");
  });

  it("commits one intent per subscribed endpoint, each with its own identity", async () => {
    const endpointIds = [
      "55555555-0000-4000-8000-000000000005",
      "66666666-0000-4000-8000-000000000006",
      "77777777-0000-4000-8000-000000000007",
    ] as const;
    const fake = fakeTx(endpointIds);
    await runInTenant((producer) =>
      producer.scheduleWebhookDeliveries(fake.tx, {
        event: "note.created",
        workspaceId: WORKSPACE_ID,
        resourceId: NOTE_ID,
        actorId: ACTOR_ID,
        occurredAt: OCCURRED_AT,
        correlationId: REQUEST_ID,
      }),
    );

    expect(fake.inserts).toHaveLength(3);
    expect(new Set(fake.inserts.map((row) => payloadOf(row).intentId)).size).toBe(3);
    expect(fake.inserts.map((row) => payloadOf(row).webhookId)).toEqual([...endpointIds]);

    for (const row of fake.inserts) {
      const payload = payloadOf(row);
      expect(row.table).toBe(jobOutbox);
      expect(row.values.workspaceId).toBe(WORKSPACE_ID);
      expect(row.values.queueName).toBe(WEBHOOK_DELIVER_SOURCE_QUEUE_NAME);
      expect(row.values.jobType).toBe(DOMAIN_JOB_TYPES.webhookDeliver);
      expect(row.values.payloadVersion).toBe(WEBHOOK_DELIVER_JOB_DEFINITION.payloadVersion);
      expect(row.values.correlationId).toBe(REQUEST_ID);
      expect(row.values.id).toBe(payload.intentId);
      // The identity the whole design rests on: the FIRST intent's event id is
      // its own intent id.
      expect(payload.eventId).toBe(payload.intentId);
      expect(payload.occurredAt).toBe(OCCURRED_AT.toISOString());
      expect(payload.resourceId).toBe(NOTE_ID);
      expect(payload.actorId).toBe(ACTOR_ID);
      expect(row.values.idempotencyKey).toBe(
        `webhook-deliver:${payload.webhookId}:${payload.eventId}`,
      );
      expect(row.values.payloadHash).toBe(
        createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      );
      // The payload must validate against the authoritative contract, not just
      // against this test's expectations.
      expect(WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("carries a null actor for a system-initiated mutation", async () => {
    const fake = fakeTx(["55555555-0000-4000-8000-000000000005"]);
    await runInTenant((producer) =>
      producer.scheduleWebhookDeliveries(fake.tx, {
        event: "note.deleted",
        workspaceId: WORKSPACE_ID,
        resourceId: NOTE_ID,
        actorId: null,
        occurredAt: OCCURRED_AT,
      }),
    );
    const payload = payloadOf(fake.inserts[0]!);
    expect(payload.actorId).toBeNull();
    expect(WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
  });

  it("a replay reuses the event id, mints a new intent id, and takes the retry key", async () => {
    const fake = fakeTx([]);
    const original: WebhookDeliverPayload = Object.freeze({
      action: DOMAIN_JOB_TYPES.webhookDeliver,
      intentId: "88888888-0000-4000-8000-000000000008",
      workspaceId: WORKSPACE_ID,
      webhookId: "55555555-0000-4000-8000-000000000005",
      eventId: "88888888-0000-4000-8000-000000000008",
      event: "note.created",
      resourceId: NOTE_ID,
      actorId: ACTOR_ID,
      occurredAt: OCCURRED_AT.toISOString(),
    });

    const scheduled = await runInTenant((producer) =>
      producer.scheduleWebhookReplay(fake.tx, {
        webhookId: original.webhookId,
        eventId: original.eventId,
        payload: original,
        correlationId: REQUEST_ID,
      }),
    );

    expect(scheduled).toBe(true);
    expect(fake.inserts).toHaveLength(1);
    const payload = payloadOf(fake.inserts[0]!);
    expect(payload.eventId).toBe(original.eventId);
    expect(payload.intentId).not.toBe(original.intentId);
    expect(fake.inserts[0]?.values.id).toBe(payload.intentId);
    // The retry key is prefixed AND carries the fresh intent id, so an admin can
    // replay the same event more than once.
    expect(fake.inserts[0]?.values.idempotencyKey).toBe(
      `webhook-deliver:retry:${original.webhookId}:${original.eventId}:${payload.intentId}`,
    );
    expect(WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
  });

  it("reports a lost conflict race rather than claiming a replay was scheduled", async () => {
    const fake = fakeTx([], true);
    const scheduled = await runInTenant((producer) =>
      producer.scheduleWebhookReplay(fake.tx, {
        webhookId: "55555555-0000-4000-8000-000000000005",
        eventId: "88888888-0000-4000-8000-000000000008",
        payload: {
          action: DOMAIN_JOB_TYPES.webhookDeliver,
          intentId: "88888888-0000-4000-8000-000000000008",
          workspaceId: WORKSPACE_ID,
          webhookId: "55555555-0000-4000-8000-000000000005",
          eventId: "88888888-0000-4000-8000-000000000008",
          event: "note.created",
          resourceId: NOTE_ID,
          actorId: ACTOR_ID,
          occurredAt: OCCURRED_AT.toISOString(),
        },
      }),
    );
    expect(scheduled).toBe(false);
  });
});
