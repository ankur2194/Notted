import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../database/schema";
import { EMBEDDING_DIMENSIONS } from "../infrastructure/embeddings/embedding-provider";
import { TenantContextService, createTenantContext } from "../tenant";

import { SemanticSearchRepository } from "./semantic-search.repository";
import { SemanticSearchService } from "./semantic-search.service";

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl !== undefined;
const vector = (first: number, second: number): number[] => [
  first,
  second,
  ...Array(EMBEDDING_DIMENSIONS - 2).fill(0),
];
const literal = (value: readonly number[]): string => `[${value.join(",")}]`;

/** Live-gated pgvector coverage: the harness seeds conceptual unit vectors in two tenants. */
describe.skipIf(!live)("semantic pgvector isolation", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool, { schema });
  const tenant = new TenantContextService();
  const repository = new SemanticSearchRepository({ db } as never, tenant);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const conceptualId = randomUUID();
  const weakerId = randomUUID();
  const deletedId = randomUUID();
  const otherTenantId = randomUUID();
  const model = "live-deterministic-model";

  beforeAll(async () => {
    await pool.query("insert into users (id, email, name) values ($1, $2, $3)", [
      userId,
      `semantic-${userId}@example.test`,
      "Semantic Fixture",
    ]);
    await pool.query(
      "insert into workspaces (id, name, slug, created_by_id) values ($1, $2, $3, $4), ($5, $6, $7, $4)",
      [
        workspaceId,
        "Semantic A",
        `semantic-a-${workspaceId}`,
        userId,
        otherWorkspaceId,
        "Semantic B",
        `semantic-b-${otherWorkspaceId}`,
      ],
    );
    for (const [id, workspace, title, deleted] of [
      [conceptualId, workspaceId, "Conceptual", false],
      [weakerId, workspaceId, "Weaker", false],
      [deletedId, workspaceId, "Deleted", true],
      [otherTenantId, otherWorkspaceId, "Other tenant", false],
    ] as const) {
      await pool.query(
        "insert into notes (id, workspace_id, title, created_by_id, is_deleted) values ($1, $2, $3, $4, $5)",
        [id, workspace, title, userId, deleted],
      );
    }
    for (const [id, embedding] of [
      [conceptualId, vector(1, 0)],
      [weakerId, vector(0.8, 0.6)],
      [deletedId, vector(1, 0)],
      [otherTenantId, vector(1, 0)],
    ] as const) {
      await pool.query(
        "insert into note_embeddings (note_id, embedding, model, content_hash, dimensions) values ($1, $2::vector, $3, $4, $5)",
        [id, literal(embedding), model, randomUUID().replaceAll("-", ""), EMBEDDING_DIMENSIONS],
      );
    }
    await pool.query(
      "insert into attachments (note_id, workspace_id, original_name, filename, mime_type, size_bytes, storage_key, processing_status, created_by_id) values ($1, $2, 'fixture.txt', 'fixture.txt', 'text/plain', 1, $3, 'ready', $4)",
      [conceptualId, workspaceId, `fixtures/${conceptualId}`, userId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from workspaces where id = any($1::uuid[])", [
      [workspaceId, otherWorkspaceId],
    ]);
    await pool.query("delete from users where id = $1", [userId]);
    await pool.end();
  });

  it("keeps tenant, deleted, and ready-attachment predicates inside semantic SQL before pagination", async () => {
    const results = await tenant.run(createTenantContext({ workspaceId, userId }), () =>
      repository.search({
        vector: vector(1, 0),
        model,
        dimensions: EMBEDDING_DIMENSIONS,
        filters: { hasAttachments: true },
        offset: 0,
        limit: 1,
      }),
    );
    expect(results.map(({ id }) => id)).toEqual([conceptualId]);
    expect(results.some(({ id }) => id === deletedId || id === otherTenantId)).toBe(false);
  });

  it("prechecks unusable query vectors and stored model compatibility before cosine execution", async () => {
    await expect(
      tenant.run(createTenantContext({ workspaceId, userId }), () =>
        repository.search({
          vector: Array(EMBEDDING_DIMENSIONS).fill(0),
          model,
          dimensions: EMBEDDING_DIMENSIONS,
          filters: {},
          offset: 0,
          limit: 2,
        }),
      ),
    ).rejects.toThrow("embedding_dimension_mismatch");
    await pool.query("update note_embeddings set model = 'incompatible-model' where note_id = $1", [
      weakerId,
    ]);
    await expect(
      tenant.run(createTenantContext({ workspaceId, userId }), () =>
        repository.search({
          vector: vector(1, 0),
          model,
          dimensions: EMBEDDING_DIMENSIONS,
          filters: {},
          offset: 0,
          limit: 2,
        }),
      ),
    ).rejects.toThrow("embedding_model_dimension_mismatch");
    await pool.query("update note_embeddings set model = $1 where note_id = $2", [model, weakerId]);
  });

  it("orders deterministic conceptual vectors and performs no provider work when disabled", async () => {
    const results = await tenant.run(createTenantContext({ workspaceId, userId }), () =>
      repository.search({
        vector: vector(1, 0),
        model,
        dimensions: EMBEDDING_DIMENSIONS,
        filters: {},
        offset: 0,
        limit: 2,
      }),
    );
    expect(results.map(({ id }) => id)).toEqual([conceptualId, weakerId]);
    const embed = vi.fn();
    const service = new SemanticSearchService(
      { availability: () => "disabled", embed } as never,
      repository,
    );
    expect(service.isAvailable()).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });
});
