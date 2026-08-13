import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HybridRankingService } from "./hybrid-ranking.service";

const meilisearchUrl = process.env.MEILISEARCH_URL;
const meilisearchKey = process.env.MEILISEARCH_API_KEY;
const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl !== undefined && meilisearchUrl !== undefined;
const indexUid = `notted_hybrid_live_${randomUUID().replaceAll("-", "")}`;
const ids = {
  exact: "10000000-0000-4000-8000-000000000001",
  typo: "10000000-0000-4000-8000-000000000002",
  conceptual: "10000000-0000-4000-8000-000000000003",
  deleted: "10000000-0000-4000-8000-000000000004",
  otherTenant: "10000000-0000-4000-8000-000000000005",
} as const;

async function meili(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${meilisearchUrl}${path}`, {
    ...init,
    headers: {
      ...(meilisearchKey === undefined ? {} : { authorization: `Bearer ${meilisearchKey}` }),
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

async function waitForTask(taskUid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await meili(`/tasks/${taskUid}`);
    const task = (await response.json()) as { readonly status?: string };
    if (task.status === "succeeded") return;
    if (task.status === "failed" || task.status === "canceled")
      throw new Error("isolated Meilisearch fixture task failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("isolated Meilisearch fixture task timed out");
}

async function mutation(path: string, body?: unknown, method = "POST"): Promise<void> {
  const response = await meili(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  const task = (await response.json()) as { readonly taskUid: number };
  await waitForTask(task.taskUid);
}

/**
 * Live-gated composition boundary. Fixtures use an isolated workspace/index and
 * deterministic pgvector unit vectors; no paid embedding provider is involved.
 */
describe.skipIf(!live)("hybrid Meilisearch + pgvector", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  beforeAll(async () => {
    await pool.query("insert into users (id, email, name) values ($1, $2, $3)", [
      userId,
      `hybrid-${userId}@example.test`,
      "Hybrid Fixture",
    ]);
    await pool.query(
      "insert into workspaces (id, name, slug, created_by_id) values ($1, 'Hybrid A', $2, $3), ($4, 'Hybrid B', $5, $3)",
      [
        workspaceId,
        `hybrid-a-${workspaceId}`,
        userId,
        otherWorkspaceId,
        `hybrid-b-${otherWorkspaceId}`,
      ],
    );
    for (const [id, workspace, title, deleted] of [
      [ids.exact, workspaceId, "release planning", false],
      [ids.typo, workspaceId, "relese planing", false],
      [ids.conceptual, workspaceId, "conceptual roadmap", false],
      [ids.deleted, workspaceId, "release deleted", true],
      [ids.otherTenant, otherWorkspaceId, "release foreign", false],
    ] as const) {
      await pool.query(
        "insert into notes (id, workspace_id, title, created_by_id, is_deleted) values ($1, $2, $3, $4, $5)",
        [id, workspace, title, userId, deleted],
      );
    }
    const vector = `[1,${Array(1535).fill(0).join(",")}]`;
    await pool.query(
      "insert into note_embeddings (note_id, embedding, model, content_hash, dimensions) values ($1, $2::vector, 'hybrid-fixture', $3, 1536)",
      [ids.conceptual, vector, randomUUID().replaceAll("-", "")],
    );
    await mutation("/indexes", { uid: indexUid, primaryKey: "id" });
    await mutation(`/indexes/${indexUid}/settings/filterable-attributes`, ["workspaceId"], "PUT");
    await mutation(`/indexes/${indexUid}/documents`, [
      { id: ids.exact, workspaceId: "tenant-a", title: "release planning", content: "exact term" },
      { id: ids.typo, workspaceId: "tenant-a", title: "relese planing", content: "typo term" },
      { id: ids.deleted, workspaceId: "tenant-a", title: "release deleted", content: "stale" },
      {
        id: ids.otherTenant,
        workspaceId: "tenant-b",
        title: "release foreign",
        content: "control",
      },
    ]);
  });

  afterAll(async () => {
    const response = await meili(`/indexes/${indexUid}`, { method: "DELETE" });
    if (response.ok) {
      const task = (await response.json()) as { readonly taskUid: number };
      await waitForTask(task.taskUid);
    }
    await pool.query("delete from workspaces where id = any($1::uuid[])", [
      [workspaceId, otherWorkspaceId],
    ]);
    await pool.query("delete from users where id = $1", [userId]);
    await pool.end();
  });

  it("unions live tenant lexical and conceptual candidates then applies authoritative exclusion", async () => {
    const response = await meili(`/indexes/${indexUid}/search`, {
      method: "POST",
      body: JSON.stringify({
        q: "release planning",
        filter: 'workspaceId = "tenant-a"',
        showRankingScore: true,
      }),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      readonly hits: readonly { readonly id: string; readonly _rankingScore?: number }[];
    };
    expect(body.hits.some(({ id }) => id === ids.otherTenant)).toBe(false);
    const authoritativeRows = await pool.query<{ id: string }>(
      "select id from notes where workspace_id = $1 and is_deleted = false and id = any($2::uuid[])",
      [workspaceId, [...body.hits.map(({ id }) => id), ids.conceptual]],
    );
    const conceptualRows = await pool.query<{ id: string }>(
      "select n.id from note_embeddings e join notes n on n.id = e.note_id where n.workspace_id = $1 and n.is_deleted = false and e.model = 'hybrid-fixture' order by e.embedding <=> $2::vector limit 1",
      [workspaceId, `[1,${Array(1535).fill(0).join(",")}]`],
    );
    expect(conceptualRows.rows.map(({ id }) => id)).toEqual([ids.conceptual]);
    const ranker = new HybridRankingService();
    const merged = ranker.merge(
      body.hits.map((hit, rank) => ({ id: hit.id, rawScore: hit._rankingScore ?? null, rank })),
      [{ id: ids.conceptual, similarity: 0.99 }],
    );
    const authoritative = new Map(
      authoritativeRows.rows.map(({ id }, index) => [
        id,
        { id, updatedAt: new Date(Date.UTC(2026, 0, 3 - index)) },
      ]),
    );
    const result = ranker.finalize(merged, authoritative);
    expect(result.map(({ id }) => id)).toEqual(
      expect.arrayContaining([ids.exact, ids.typo, ids.conceptual]),
    );
    expect(result.some(({ id }) => id === ids.deleted || id === ids.otherTenant)).toBe(false);
  });

  it("keeps curated lexical/conceptual ordering and composes deterministic text-only fallback", async () => {
    const ranker = new HybridRankingService();
    const lexical = [
      { id: ids.exact, rawScore: 1, rank: 0 },
      { id: ids.typo, rawScore: 0.6, rank: 1 },
    ];
    const facts = new Map([
      [ids.exact, { id: ids.exact, updatedAt: new Date("2026-01-03") }],
      [ids.typo, { id: ids.typo, updatedAt: new Date("2026-01-02") }],
      [ids.conceptual, { id: ids.conceptual, updatedAt: new Date("2026-01-01") }],
    ]);
    expect(
      ranker
        .finalize(ranker.merge(lexical, [{ id: ids.conceptual, similarity: 1 }]), facts)
        .map(({ id }) => id),
    ).toEqual([ids.exact, ids.conceptual, ids.typo]);
    expect(ranker.finalize(ranker.merge(lexical, []), facts).map(({ id }) => id)).toEqual([
      ids.exact,
      ids.typo,
    ]);
  });
});
