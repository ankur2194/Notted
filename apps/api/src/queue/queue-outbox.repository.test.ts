import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { parseQueueConfig } from "../config/queue.config";

import { DOMAIN_JOB_TYPES } from "./job-identifiers";
import { UNCONSUMED_JOB_TYPES } from "./job-registry";
import { QueueOutboxRepository } from "./queue-outbox.repository";

import type { DatabaseService } from "../database/database.service";
import type { SQL } from "drizzle-orm";

function setup() {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const repository = new QueueOutboxRepository(
    { db: { execute } } as unknown as DatabaseService,
    parseQueueConfig({}),
  );
  return { execute, repository };
}

describe("QueueOutboxRepository.claimBatch", () => {
  it('excludes types declared consumer:"none" from the claim query', async () => {
    const { execute, repository } = setup();
    await repository.claimBatch(100, 30_000);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    // The single `$n::text[]` placeholder is the assertion that matters:
    // drizzle spreads a bare array into one placeholder per element, which
    // builds `any(($1, $2, ...)::text[])` and is invalid SQL.
    expect(query.sql).toMatch(/job_type <> all\(\$\d+::text\[\]\)/u);
    expect(query.params).toContainEqual([...UNCONSUMED_JOB_TYPES]);
    expect(UNCONSUMED_JOB_TYPES).toContain(DOMAIN_JOB_TYPES.noteCreated);
    expect(UNCONSUMED_JOB_TYPES).toContain(DOMAIN_JOB_TYPES.taskCreated);
  });

  it("gives a running dispatched row the slowest worker timeout, not the claim window", async () => {
    // `withTimeout` bounds a handler by its lane's `timeoutMs`, and the export
    // lane defaults to 600 s. Reclaiming a `dispatched` row after 30 s
    // interrupts a live export: the second claim finds the idempotency key
    // `processing`, flips it to `reconciliation_required`, and the original
    // worker's `completeExecution` (which matches `status = 'processing'`) then
    // updates nothing -- leaving the key poisoned for a job that succeeded.
    const { execute, repository } = setup();
    await repository.claimBatch(100, 30_000);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    const dispatching = query.sql.indexOf("status = 'dispatching'");
    const dispatched = query.sql.indexOf("status = 'dispatched'");
    // Placeholder numbers are 1-based and assigned left to right, so the index
    // of each arm's parameter follows from how many placeholders precede it.
    const placeholderAt = (from: number): unknown => {
      const marker = /\$(\d+)/u.exec(query.sql.slice(from));
      return query.params[Number(marker?.[1]) - 1];
    };
    expect(placeholderAt(dispatching)).toBe(30_000);
    // 600 000 (the export lane) + the 30 000 claim window.
    expect(placeholderAt(dispatched)).toBe(630_000);
  });

  it("does not exclude a type whose consumer is merely undeployed", async () => {
    // The rollout safety gate still has to reach `releaseUnhandled`, so
    // `workspace.deleted` must remain claimable.
    expect(UNCONSUMED_JOB_TYPES).not.toContain(DOMAIN_JOB_TYPES.workspaceDeleted);
    expect(UNCONSUMED_JOB_TYPES).not.toContain(DOMAIN_JOB_TYPES.generateExport);
    expect(UNCONSUMED_JOB_TYPES).not.toContain(DOMAIN_JOB_TYPES.webhookDeliver);
    expect(UNCONSUMED_JOB_TYPES).not.toContain(DOMAIN_JOB_TYPES.noteSearchSync);
  });

  it("marks every domain-event type and nothing else", () => {
    // 27 `actorDefinition` entries: 9 note/folder + 2 note.share + 6 project +
    // 3 tag + 5 task + 2 attachment.
    expect(UNCONSUMED_JOB_TYPES).toHaveLength(27);
    expect(
      UNCONSUMED_JOB_TYPES.every((jobType) =>
        /^(note|folder|project|tag|task|attachment)\./.test(jobType),
      ),
    ).toBe(true);
    expect(UNCONSUMED_JOB_TYPES).not.toContain(DOMAIN_JOB_TYPES.noteSearchSync);
    expect(UNCONSUMED_JOB_TYPES).not.toContain(DOMAIN_JOB_TYPES.noteEmbeddingGenerate);
  });
});
