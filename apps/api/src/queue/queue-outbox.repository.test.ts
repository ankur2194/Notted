import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { DOMAIN_JOB_TYPES } from "./job-identifiers";
import { UNCONSUMED_JOB_TYPES } from "./job-registry";
import { QueueOutboxRepository } from "./queue-outbox.repository";

import type { QueueConfig } from "../config/queue.config";
import type { DatabaseService } from "../database/database.service";
import type { SQL } from "drizzle-orm";

function setup() {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const repository = new QueueOutboxRepository(
    { db: { execute } } as unknown as DatabaseService,
    {} as QueueConfig,
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
