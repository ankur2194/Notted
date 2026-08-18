import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { emailDeliveries, jobOutbox } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  WORKSPACE_EMAIL_JOB_DEFINITION,
  WORKSPACE_EMAIL_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { createTenantContext, TenantContextService } from "../tenant";

import {
  WORKSPACE_EMAIL_IDEMPOTENCY_PREFIX,
  WorkspaceEmailProducerService,
  workspaceEmailIdempotencyKey,
} from "./workspace-email-producer.service";

import type { DatabaseTransaction } from "../database/database.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const NOTE_ID = "22222222-0000-4000-8000-000000000002";
const OTHER_NOTE_ID = "33333333-0000-4000-8000-000000000003";
const ACTOR_ID = "44444444-0000-4000-8000-000000000004";
const REQUEST_ID = "55555555-0000-4000-8000-000000000005";

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

interface FakeTx {
  readonly tx: DatabaseTransaction;
  readonly inserts: InsertedRow[];
  readonly selects: number[];
}

/**
 * Records inserts and answers the single suppression lookup. `suppressed`
 * decides what that lookup returns; `takenKeys` is the set of idempotency keys
 * an earlier committed transaction already owns, which is what
 * `job_outbox_idempotency_key_unique` enforces in PostgreSQL.
 */
function fakeTx(options: { suppressed?: boolean; takenKeys?: Set<string> } = {}): FakeTx {
  const inserts: InsertedRow[] = [];
  const selects: number[] = [];
  const taken = options.takenKeys ?? new Set<string>();
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const chain = {
          onConflictDoNothing: () => ({
            returning: () => {
              const key = String(values.idempotencyKey);
              if (taken.has(key)) return Promise.resolve([]);
              taken.add(key);
              inserts.push({ table, values });
              return Promise.resolve([{ id: values.id }]);
            },
          }),
          then: (resolve: (value: undefined) => unknown) => {
            inserts.push({ table, values });
            return Promise.resolve(undefined).then(resolve);
          },
        };
        return chain;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selects.push(1);
            return options.suppressed === true ? [{ id: WORKSPACE_ID }] : [];
          },
        }),
      }),
    }),
  };
  return { tx: tx as unknown as DatabaseTransaction, inserts, selects };
}

function producerFor(): {
  readonly producer: WorkspaceEmailProducerService;
  readonly tenant: TenantContextService;
} {
  const tenant = new TenantContextService();
  return { producer: new WorkspaceEmailProducerService(tenant), tenant };
}

const mentionInput = {
  templateKey: "mention",
  recipient: "Ada@Example.Test",
  workspaceId: WORKSPACE_ID,
  relatedEntityType: "note",
  relatedEntityId: NOTE_ID,
  actorId: ACTOR_ID,
  correlationId: REQUEST_ID,
} as const;

async function runInTenant<T>(tenant: TenantContextService, fn: () => Promise<T>): Promise<T> {
  return tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: null }), fn);
}

describe("WorkspaceEmailProducerService.queue", () => {
  it("rejects a blank recipient before writing anything", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx();
    await expect(
      runInTenant(tenant, () => producer.queue(fake.tx, { ...mentionInput, recipient: "   " })),
    ).rejects.toThrow("Email recipient is required");
    expect(fake.inserts).toHaveLength(0);
  });

  it("writes one suppressed delivery and no outbox row when the recipient opted out", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx({ suppressed: true });
    const result = await runInTenant(tenant, () => producer.queue(fake.tx, mentionInput));

    expect(result.outcome).toBe("suppressed");
    expect(result.deliveryId).not.toBeNull();
    expect(fake.inserts).toHaveLength(1);
    const row = fake.inserts[0]!;
    expect(row.table).toBe(emailDeliveries);
    expect(row.values.status).toBe("suppressed");
    // Normalised on write so the suppression lookup can match it later.
    expect(row.values.recipient).toBe("ada@example.test");
    expect(fake.inserts.some((insert) => insert.table === jobOutbox)).toBe(false);
  });

  it("commits the outbox intent and its delivery for a fresh business event", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx();
    const result = await runInTenant(tenant, () => producer.queue(fake.tx, mentionInput));

    expect(result.outcome).toBe("queued");
    expect(fake.inserts).toHaveLength(2);
    const outbox = fake.inserts[0]!;
    const delivery = fake.inserts[1]!;
    // The outbox row goes FIRST: losing the conflict must not leave an orphan
    // `queued` delivery behind.
    expect(outbox.table).toBe(jobOutbox);
    expect(delivery.table).toBe(emailDeliveries);
    expect(outbox.values.queueName).toBe(WORKSPACE_EMAIL_SOURCE_QUEUE_NAME);
    expect(outbox.values.jobType).toBe(DOMAIN_JOB_TYPES.deliverWorkspaceEmail);
    expect(outbox.values.payloadVersion).toBe(WORKSPACE_EMAIL_JOB_DEFINITION.payloadVersion);
    expect(outbox.values.correlationId).toBe(REQUEST_ID);

    const payload = outbox.values.payload as Record<string, unknown>;
    expect(payload.deliveryId).toBe(result.deliveryId);
    expect(payload.workspaceId).toBe(WORKSPACE_ID);
    expect(payload.actorId).toBe(ACTOR_ID);
    expect(outbox.values.id).toBe(payload.intentId);
    // No subject identifier travels in the payload; the delivery row owns it.
    expect(payload.relatedEntityId).toBeUndefined();
    expect(delivery.values.relatedEntityId).toBe(NOTE_ID);
    expect(delivery.values.status).toBe("queued");

    // The registered schema must accept exactly what the producer writes and
    // reject any leaked content field.
    expect(WORKSPACE_EMAIL_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
    expect(
      WORKSPACE_EMAIL_JOB_DEFINITION.payloadSchema.safeParse({ ...payload, noteTitle: "Secret" })
        .success,
    ).toBe(false);
    expect(outbox.values.payloadHash).toBe(
      createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    );
  });

  it("collapses an identical repeated event to one outbox row and one delivery", async () => {
    const { producer, tenant } = producerFor();
    const takenKeys = new Set<string>();
    const first = fakeTx({ takenKeys });
    const second = fakeTx({ takenKeys });

    const firstResult = await runInTenant(tenant, () => producer.queue(first.tx, mentionInput));
    const secondResult = await runInTenant(tenant, () => producer.queue(second.tx, mentionInput));

    expect(firstResult.outcome).toBe("queued");
    expect(secondResult).toEqual({ deliveryId: null, outcome: "duplicate" });
    expect(first.inserts).toHaveLength(2);
    // The losing transaction writes nothing at all — no orphan delivery row.
    expect(second.inserts).toHaveLength(0);
  });

  it("accepts a workspace-less system email outside any tenant context", async () => {
    const { producer } = producerFor();
    const fake = fakeTx();
    const result = await producer.queue(fake.tx, {
      templateKey: "welcome",
      recipient: "ada@example.test",
      workspaceId: null,
      relatedEntityType: "user",
      relatedEntityId: ACTOR_ID,
    });

    expect(result.outcome).toBe("queued");
    // `welcome` is mandatory, so no suppression query is issued at all.
    expect(fake.selects).toHaveLength(0);
    const payload = fake.inserts[0]!.values.payload as Record<string, unknown>;
    expect(payload.workspaceId).toBeNull();
    expect(payload.actorId).toBeUndefined();
    expect(WORKSPACE_EMAIL_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
  });

  it("refuses to write for a workspace other than the active tenant", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx();
    await expect(
      runInTenant(tenant, () =>
        producer.queue(fake.tx, { ...mentionInput, workspaceId: OTHER_NOTE_ID }),
      ),
    ).rejects.toThrow();
    expect(fake.inserts).toHaveLength(0);
  });
});

describe("workspaceEmailIdempotencyKey", () => {
  const base = {
    templateKey: "mention",
    recipient: "ada@example.test",
    relatedEntityType: "note",
    relatedEntityId: NOTE_ID,
  } as const;

  it("is stable for identical input", () => {
    expect(workspaceEmailIdempotencyKey(base)).toBe(workspaceEmailIdempotencyKey(base));
    expect(workspaceEmailIdempotencyKey(base)).toBe(
      `${WORKSPACE_EMAIL_IDEMPOTENCY_PREFIX}${createHash("sha256")
        .update(JSON.stringify(base))
        .digest("hex")}`,
    );
  });

  it("differs across recipient, related entity and template", () => {
    const key = workspaceEmailIdempotencyKey(base);
    expect(workspaceEmailIdempotencyKey({ ...base, recipient: "grace@example.test" })).not.toBe(
      key,
    );
    expect(workspaceEmailIdempotencyKey({ ...base, relatedEntityId: OTHER_NOTE_ID })).not.toBe(key);
    expect(workspaceEmailIdempotencyKey({ ...base, templateKey: "export_ready" })).not.toBe(key);
  });
});
