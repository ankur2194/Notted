import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { notes } from "../src/database/schema";

const migrationPath = resolve(process.cwd(), "src/database/migrations/0012_vengeful_payback.sql");
const correctionMigrationPath = resolve(
  process.cwd(),
  "src/database/migrations/0013_free_lockheed.sql",
);
const boardColumnMigrationPath = resolve(
  process.cwd(),
  "src/database/migrations/0015_lumpy_phil_sheldon.sql",
);
const journalPath = resolve(process.cwd(), "src/database/migrations/meta/_journal.json");
const expected = [
  "notes_workspace_project_parent_order_idx",
  "notes_workspace_folder_parent_order_idx",
  "notes_workspace_trash_deleted_idx",
  "notes_workspace_pinned_archive_updated_idx",
  "notes_workspace_template_updated_idx",
  "notes_workspace_archive_updated_idx",
  // Part 49: the note-board column partition. Appended, so the `slice(0, 4)`
  // assertion below still names exactly the four indexes 0012 created.
  "notes_workspace_board_column_idx",
] as const;

describe("Part 31 note indexes and forward migration artifacts", () => {
  it("declares only the evidence-backed note view/order indexes", () => {
    const names = new Set(getTableConfig(notes).indexes.map((index) => index.config.name));
    for (const name of expected) expect(names.has(name)).toBe(true);
  });

  it("keeps 0012 additive/index-only and appends the journal chain", () => {
    const sql = readFileSync(migrationPath, "utf8");
    for (const name of expected.slice(0, 4)) expect(sql).toContain(`CREATE INDEX "${name}"`);
    expect(sql).not.toMatch(/\b(?:alter|drop|delete|update|insert|truncate)\b/i);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    // Pinned by index, not by "last entry": the point is that 0013 was APPENDED
    // in order and nothing renumbered the chain behind it. Asserting the tail
    // would make every future migration fail this test for no reason.
    expect(journal.entries[13]).toMatchObject({ idx: 13, tag: "0013_free_lockheed" });
    expect(journal.entries[15]).toMatchObject({ idx: 15, tag: "0015_lumpy_phil_sheldon" });
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_entry, index) => index),
    );
  });

  /**
   * The note board reuses `task_statuses`, so the only schema this part adds
   * is one nullable FK column plus its index. NULL is the correct value for
   * every existing row — it is the leading "No column" bucket — which is why
   * this migration carries no backfill and no `UPDATE`.
   */
  it("adds the board column as a nullable SET NULL reference with no backfill", () => {
    const sql = readFileSync(boardColumnMigrationPath, "utf8");
    expect(sql).toContain('ALTER TABLE "notes" ADD COLUMN "board_column_id" uuid');
    expect(sql).toContain('REFERENCES "public"."task_statuses"("id") ON DELETE set null');
    expect(sql).toContain('CREATE INDEX "notes_workspace_board_column_idx"');
    // No backfill, no rewrite: `ON UPDATE`/`ON DELETE` inside the constraint
    // are the only occurrences, so the statement forms are what is asserted.
    expect(sql).not.toMatch(/UPDATE\s+"notes"|DELETE\s+FROM|DROP\s|TRUNCATE/i);
    expect(sql).not.toContain("NOT NULL");
  });

  it("keeps the forward correction ordered and includes the durable restriction backfill", () => {
    const sql = readFileSync(correctionMigrationPath, "utf8");
    expect(sql.indexOf('ADD COLUMN "is_restricted"')).toBeLessThan(
      sql.indexOf('SET "is_restricted" = true'),
    );
    expect(sql).toContain('FROM "project_access"');
    expect(sql).toContain('ADD COLUMN "deletion_batch_id" uuid');
    expect(sql).toContain('CREATE INDEX "notes_workspace_template_updated_idx"');
    expect(sql).toContain('CREATE INDEX "notes_workspace_archive_updated_idx"');
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
describe.skipIf(typeof DATABASE_URL !== "string" || DATABASE_URL.trim() === "")(
  "Part 31 note indexes (live PostgreSQL)",
  () => {
    it("exposes every generated index after the forward chain is applied", async () => {
      const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
      await client.connect();
      try {
        await migrate(drizzle(client), {
          migrationsFolder: resolve(process.cwd(), "src/database/migrations"),
        });
        const result = await client.query<{ indexname: string }>(
          "select indexname from pg_indexes where schemaname = 'public' and tablename = 'notes'",
        );
        const names = new Set(result.rows.map((row) => row.indexname));
        for (const name of expected) expect(names.has(name)).toBe(true);
      } finally {
        await client.end();
      }
    });

    it("records representative planner evidence for tree and lifecycle views", async () => {
      const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
      await client.connect();
      try {
        await migrate(drizzle(client), {
          migrationsFolder: resolve(process.cwd(), "src/database/migrations"),
        });
        await client.query("set enable_seqscan = off");
        const workspaceId = "10000000-0000-4000-8000-000000000001";
        const projectId = "20000000-0000-4000-8300-000000000001";
        const folderId = "21000000-0000-4000-8400-000000000001";
        const cases = [
          {
            name: "project tree",
            sql: `select id from notes where workspace_id = '${workspaceId}' and project_id = '${projectId}' and parent_id is null order by sort_order`,
          },
          {
            name: "folder tree",
            sql: `select id from notes where workspace_id = '${workspaceId}' and folder_id = '${folderId}' and parent_id is null order by sort_order`,
          },
          {
            name: "pinned",
            sql: `select id from notes where workspace_id = '${workspaceId}' and is_deleted = false and is_pinned = true and is_archived = false order by updated_at desc`,
          },
          {
            name: "template",
            sql: `select id from notes where workspace_id = '${workspaceId}' and is_deleted = false and is_template = true order by updated_at desc`,
          },
          {
            name: "archived",
            sql: `select id from notes where workspace_id = '${workspaceId}' and is_deleted = false and is_archived = true order by updated_at desc`,
          },
          {
            name: "trash",
            sql: `select id from notes where workspace_id = '${workspaceId}' and is_deleted = true order by deleted_at desc`,
          },
        ] as const;
        for (const fixture of cases) {
          const plan = await client.query(`explain (costs off) ${fixture.sql}`);
          const planStr = JSON.stringify(plan.rows);
          expect(planStr, `${fixture.name}: expected a tenant-scoped index scan`).toContain(
            "Index Scan",
          );
          expect(
            planStr,
            `${fixture.name}: expected the index condition to be scoped by workspace_id`,
          ).toContain(`workspace_id = '${workspaceId}'`);
          expect(planStr, `${fixture.name}: expected no sequential scan`).not.toContain("Seq Scan");
        }
      } finally {
        await client.end();
      }
    });
  },
);
