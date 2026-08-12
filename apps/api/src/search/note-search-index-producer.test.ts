import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { jobOutbox } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  NOTE_SEARCH_SYNC_JOB_DEFINITION,
  NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { createTenantContext, TenantContextService, TenantError } from "../tenant";

import {
  chunkNoteIds,
  NOTE_SEARCH_SYNC_BATCH_SIZE,
  NOTE_SEARCH_SYNC_IDEMPOTENCY_PREFIX,
  NoteSearchIndexProducer,
} from "./note-search-index-producer";

import type { DatabaseTransaction } from "../database/database.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "22222222-0000-4000-8000-000000000002";
const ACTOR_ID = "33333333-0000-4000-8000-000000000003";
const REQUEST_ID = "44444444-0000-4000-8000-000000000004";
const MUTATION = "note.updated";

/** Stable fixture note UUIDs (9 of them so chunking is observable). */
const NOTE_IDS = Object.freeze(
  Array.from({ length: 9 }, (_, index) =>
    ["0000000a", "-0001", "-4000", "-8000", `-00000000${String(index + 1).padStart(4, "0")}`].join(
      "",
    ),
  ),
);

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

/**
 * Captures every `tx.insert(jobOutbox).values(...)` so the assertions can read
 * the produced intent without a database. The fake `tx` only implements
 * `insert`; the producer makes no other calls on the transaction.
 */
function fakeTx(captures: InsertedRow[]): DatabaseTransaction {
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        captures.push({ table, values });
        return Promise.resolve(undefined);
      },
    }),
  };
  return tx as unknown as DatabaseTransaction;
}

function producerFor(): {
  readonly producer: NoteSearchIndexProducer;
  readonly tenant: TenantContextService;
} {
  const tenant = new TenantContextService();
  return {
    producer: new NoteSearchIndexProducer(tenant),
    tenant,
  };
}

/**
 * Run `fn` inside an active tenant context so the producer's
 * `activeWorkspaceId` calls succeed. The producer nevermutates the context,
 * only reads it.
 */
async function runInTenant<T>(
  tenant: TenantContextService,
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tenant.run(createTenantContext({ workspaceId, userId: null }), fn);
}

describe("NoteSearchIndexProducer contract", () => {
  it("is a no-op when the note id list is empty (no row inserted)", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [], {
        mutation: MUTATION,
        correlationId: REQUEST_ID,
        actorId: ACTOR_ID,
      }),
    );
    expect(captured).toHaveLength(0);
  });

  it("emits one outbox row for a single note and hashes the canonical payload", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
        correlationId: REQUEST_ID,
        actorId: ACTOR_ID,
      }),
    );
    expect(captured).toHaveLength(1);
    const row = captured[0]!;
    expect(row.table).toBe(jobOutbox);
    expect(row.values.workspaceId).toBe(WORKSPACE_ID);
    expect(row.values.queueName).toBe(NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME);
    expect(row.values.jobType).toBe(DOMAIN_JOB_TYPES.noteSearchSync);
    expect(row.values.payloadVersion).toBe(NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadVersion);
    expect(row.values.correlationId).toBe(REQUEST_ID);

    const payload = row.values.payload as {
      readonly action: string;
      readonly intentId: string;
      readonly workspaceId: string;
      readonly resourceIds: readonly string[];
      readonly actorId: string;
    };
    expect(payload.action).toBe(DOMAIN_JOB_TYPES.noteSearchSync);
    expect(payload.workspaceId).toBe(WORKSPACE_ID);
    expect(payload.resourceIds).toEqual([NOTE_IDS[0]]);
    expect(payload.actorId).toBe(ACTOR_ID);
    expect(row.values.id).toBe(payload.intentId);
    const idempotencyDigest = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: WORKSPACE_ID,
          mutation: MUTATION,
          intentId: payload.intentId,
        }),
      )
      .digest("hex");
    expect(row.values.idempotencyKey).toBe(
      `${NOTE_SEARCH_SYNC_IDEMPOTENCY_PREFIX}${idempotencyDigest}`,
    );
    // The hash MUST match the canonical sha256 pattern used by every other
    // producer; the dispatcher's replay-validation relies on the same shape.
    const expectedHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    expect(row.values.payloadHash).toBe(expectedHash);
  });

  it("omits actorId entirely when none is supplied (identifier-only payload)", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
      }),
    );
    const payload = captured[0]!.values.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("actorId");
    // The hash is recomputed from the payload without actorId, so it must NOT
    // match a hash that includes actorId.
    const withoutActor = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    expect(captured[0]!.values.payloadHash).toBe(withoutActor);
  });

  it("chunks a 9-id list into two rows (8 + 1) and preserves caller order", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, NOTE_IDS, {
        mutation: MUTATION,
        actorId: ACTOR_ID,
      }),
    );
    expect(captured).toHaveLength(2);
    const first = captured[0]!.values.payload as { readonly resourceIds: readonly string[] };
    const second = captured[1]!.values.payload as { readonly resourceIds: readonly string[] };
    expect(first.resourceIds).toEqual(NOTE_IDS.slice(0, NOTE_SEARCH_SYNC_BATCH_SIZE));
    expect(second.resourceIds).toEqual(NOTE_IDS.slice(NOTE_SEARCH_SYNC_BATCH_SIZE));
    // Each chunk's resourceIds is bounded by the schema cap.
    expect(first.resourceIds.length).toBeLessThanOrEqual(NOTE_SEARCH_SYNC_BATCH_SIZE);
    expect(second.resourceIds.length).toBeLessThanOrEqual(NOTE_SEARCH_SYNC_BATCH_SIZE);
    // Each row carries its own fresh intentId; the contract requires fresh
    // intents per chunk so dispatch retries on one chunk never block the other.
    expect((captured[0]!.values.payload as { intentId: string }).intentId).not.toBe(
      (captured[1]!.values.payload as { intentId: string }).intentId,
    );
    // Idempotency keys differ because the intentIds differ.
    expect(captured[0]!.values.idempotencyKey).not.toBe(captured[1]!.values.idempotencyKey);
  });

  it("does not suppress later legitimate edits of the same note", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, async () => {
      await producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
      });
      await producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
      });
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.values.idempotencyKey).not.toBe(captured[1]!.values.idempotencyKey);
  });

  it("rejects a workspace id that does not match the active tenant context", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await expect(
      runInTenant(tenant, WORKSPACE_ID, () =>
        producer.scheduleSearchSync(fakeTx(captured), OTHER_WORKSPACE_ID, [NOTE_IDS[0]!], {
          mutation: MUTATION,
        }),
      ),
    ).rejects.toBeInstanceOf(TenantError);
    // No row was inserted because the assertion fires before any SQL.
    expect(captured).toHaveLength(0);
  });

  it("rejects when no tenant context is active (deny by default)", async () => {
    const { producer } = producerFor();
    const captured: InsertedRow[] = [];
    // Calling outside any tenant.run(...) — the helper reads the active
    // workspace and the no-active-context error fires first.
    await expect(
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
      }),
    ).rejects.toBeDefined();
    expect(captured).toHaveLength(0);
  });

  it("validates the produced row against the registered outbox schema", async () => {
    // The dispatcher's payload schema must accept exactly the shape this
    // producer writes; this guards against drift in either direction.
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
        actorId: ACTOR_ID,
      }),
    );
    const payload = captured[0]!.values.payload;
    expect(NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
    // The payload must reject a leaked content field — that proves the
    // producer stayed identifier-only.
    expect(
      NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadSchema.safeParse({
        ...(payload as Record<string, unknown>),
        content: "leak",
      }).success,
    ).toBe(false);
  });
});

describe("chunkNoteIds helper", () => {
  it("returns an empty list for an empty input", () => {
    expect(chunkNoteIds([])).toEqual([]);
  });

  it("returns exactly one chunk for a list at the cap", () => {
    const ids = NOTE_IDS.slice(0, NOTE_SEARCH_SYNC_BATCH_SIZE);
    expect(chunkNoteIds(ids)).toEqual([ids]);
  });

  it("deduplicates note ids before chunking while preserving first-seen order", () => {
    expect(chunkNoteIds([NOTE_IDS[0]!, NOTE_IDS[1]!, NOTE_IDS[0]!, NOTE_IDS[2]!])).toEqual([
      [NOTE_IDS[0], NOTE_IDS[1], NOTE_IDS[2]],
    ]);
  });

  it("returns 2 chunks for a 12-id list (8 + 4)", () => {
    const ids = Object.freeze(
      Array.from({ length: 12 }, (_, index) =>
        [
          "0000000b",
          "-0001",
          "-4000",
          "-8000",
          `-00000000${String(index + 1).padStart(4, "0")}`,
        ].join(""),
      ),
    );
    const chunks = chunkNoteIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(8);
    expect(chunks[1]).toHaveLength(4);
    // Unique input order is preserved exactly — no re-sorting or shuffling.
    expect(chunks.flat()).toEqual(ids);
  });

  it("never produces a chunk larger than the batch size", () => {
    const ids = Object.freeze(
      Array.from({ length: 25 }, (_, index) =>
        [
          "0000000c",
          "-0001",
          "-4000",
          "-8000",
          `-00000000${String(index + 1).padStart(4, "0")}`,
        ].join(""),
      ),
    );
    for (const chunk of chunkNoteIds(ids)) {
      expect(chunk.length).toBeLessThanOrEqual(NOTE_SEARCH_SYNC_BATCH_SIZE);
    }
  });
});

/**
 * The `note.search.sync` job's physical queue name and source queue must match
 * what the producer writes; the dispatcher rejects unknown queue/type pairs.
 * This is the contract test that proves the producer and the registration
 * agree.
 */
describe("producer ↔ registry wiring", () => {
  it("writes the queue name and job type the registry expects", async () => {
    const { producer, tenant } = producerFor();
    const captured: InsertedRow[] = [];
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleSearchSync(fakeTx(captured), WORKSPACE_ID, [NOTE_IDS[0]!], {
        mutation: MUTATION,
      }),
    );
    const row = captured[0]!;
    expect(row.values.queueName).toBe(NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME);
    expect(row.values.jobType).toBe(NOTE_SEARCH_SYNC_JOB_DEFINITION.jobType);
    expect(row.values.payloadVersion).toBe(NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadVersion);
  });
});
