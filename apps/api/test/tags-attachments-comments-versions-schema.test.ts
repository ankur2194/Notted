import { resolve } from "node:path";

import { isTable, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachmentMediaTypeEnum,
  attachmentStatusEnum,
  attachments,
  attachmentsRelations,
  comments,
  commentsRelations,
  noteTags,
  noteTagsRelations,
  noteVersions,
  noteVersionsRelations,
  schema,
  tags,
  tagsRelations,
} from "../src/database/schema";

import { expectPostgresErrorCode, primaryKeyColumns } from "./database-test-helpers";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";

/** True when `value` looks like a Drizzle `Relations` object (config + table). */
function isRelationsObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { config?: unknown }).config === "function" &&
    typeof (value as { table?: unknown }).table === "object"
  );
}

/** Map of index name -> isUnique for a table, via Drizzle metadata. */
function indexUniqueness(table: PgTable): Map<string, boolean> {
  return new Map(
    getTableConfig(table).indexes.map((idx) => [idx.config.name ?? "", idx.config.unique]),
  );
}

/** Map of FK name -> onDelete action for a table, via Drizzle metadata. */
function fkOnDelete(table: PgTable): Map<string, string> {
  return new Map(
    getTableConfig(table).foreignKeys.map((key) => [key.getName(), key.onDelete ?? "no action"]),
  );
}

/** PostgreSQL error codes asserted by the live suite. */
const PG_UNIQUE_VIOLATION = "23505";

// ----------------------------------------------------------------------------
// Unit tests: schema shape, columns, indexes, enums, relations, and the
// note_tags composite primary key. These run without a database because they
// only inspect Drizzle metadata declared in TypeScript.
// ----------------------------------------------------------------------------

describe("tags, attachments, comments, and note versions schema (unit)", () => {
  it("exposes the Part 16 tables, enums, and relations in the schema barrel", () => {
    expect(isTable(schema.tags)).toBe(true);
    expect(isTable(schema.noteTags)).toBe(true);
    expect(isTable(schema.attachments)).toBe(true);
    expect(isTable(schema.comments)).toBe(true);
    expect(isTable(schema.noteVersions)).toBe(true);

    for (const rel of [
      schema.tagsRelations,
      schema.noteTagsRelations,
      schema.attachmentsRelations,
      schema.commentsRelations,
      schema.noteVersionsRelations,
    ]) {
      expect(isRelationsObject(rel)).toBe(true);
    }
  });

  it("exports each Part 16 table, relation, and enum by name", () => {
    expect(tags).toBe(schema.tags);
    expect(noteTags).toBe(schema.noteTags);
    expect(attachments).toBe(schema.attachments);
    expect(comments).toBe(schema.comments);
    expect(noteVersions).toBe(schema.noteVersions);

    expect(tagsRelations).toBe(schema.tagsRelations);
    expect(noteTagsRelations).toBe(schema.noteTagsRelations);
    expect(attachmentsRelations).toBe(schema.attachmentsRelations);
    expect(commentsRelations).toBe(schema.commentsRelations);
    expect(noteVersionsRelations).toBe(schema.noteVersionsRelations);

    expect(attachmentStatusEnum).toBe(schema.attachmentStatusEnum);
    expect(attachmentMediaTypeEnum).toBe(schema.attachmentMediaTypeEnum);
  });

  it("declares the Part 16 enums with the expected values", () => {
    expect(attachmentStatusEnum.enumName).toBe("attachment_status");
    expect(attachmentStatusEnum.enumValues).toEqual(["pending", "processing", "ready", "failed"]);

    expect(attachmentMediaTypeEnum.enumName).toBe("attachment_media_type");
    expect(attachmentMediaTypeEnum.enumValues).toEqual(["image", "file"]);
  });

  it("declares tags with unique workspace tag names and a workspace lookup index", () => {
    const cols = new Map(getTableConfig(tags).columns.map((c) => [c.name, c]));
    expect(primaryKeyColumns(tags)).toContainEqual(["id"]);
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("name")?.notNull).toBe(true);
    expect(cols.get("color")?.notNull).toBe(false);
    expect(cols.get("created_at")?.notNull).toBe(true);
    // No created_by_id on tags (workspace-level resource, per brief).
    expect(cols.has("created_by_id")).toBe(false);

    // Unique (workspace_id, name) — Plan Part 16 "unique workspace tag names".
    expect(indexUniqueness(tags).get("tags_workspace_name_unique")).toBe(true);
    // Workspace list lookup.
    expect(indexUniqueness(tags).get("tags_workspace_id_idx")).toBe(false);
  });

  it("declares note_tags with a composite primary key on (note_id, tag_id) and no synthetic id", () => {
    const config = getTableConfig(noteTags);
    const cols = new Map(config.columns.map((c) => [c.name, c]));

    // No synthetic `id` column — Plan Part 16 "composite primary keys for
    // junction rows".
    expect(cols.has("id")).toBe(false);
    expect(cols.get("note_id")?.notNull).toBe(true);
    expect(cols.get("tag_id")?.notNull).toBe(true);
    expect(primaryKeyColumns(noteTags)).toEqual([["note_id", "tag_id"]]);

    // "Notes with tag X" reverse lookup index.
    expect(indexUniqueness(noteTags).get("note_tags_tag_id_idx")).toBe(false);
  });

  it("declares attachments with the processing-state and variant model (ADR 0005)", () => {
    const cols = new Map(getTableConfig(attachments).columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "note_id",
      "workspace_id",
      "original_name",
      "filename",
      "mime_type",
      "size_bytes",
      "storage_key",
      "media_type",
      "processing_status",
      "processing_error",
      "variants",
      "width",
      "height",
      "created_by_id",
      "created_at",
    ]) {
      expect(cols.has(name), `attachments.${name}`).toBe(true);
    }

    // Required metadata is NOT NULL.
    expect(cols.get("note_id")?.notNull).toBe(true);
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("original_name")?.notNull).toBe(true);
    expect(cols.get("filename")?.notNull).toBe(true);
    expect(cols.get("mime_type")?.notNull).toBe(true);
    expect(cols.get("size_bytes")?.notNull).toBe(true);
    expect(cols.get("storage_key")?.notNull).toBe(true);
    // Processing-state defaults (NOT NULL with safe pending/file defaults).
    expect(cols.get("processing_status")?.notNull).toBe(true);
    expect(cols.get("media_type")?.notNull).toBe(true);
    // Nullable: error, variants metadata, primary dimensions.
    expect(cols.get("processing_error")?.notNull).toBe(false);
    expect(cols.get("variants")?.notNull).toBe(false);
    expect(cols.get("width")?.notNull).toBe(false);
    expect(cols.get("height")?.notNull).toBe(false);

    // Lookup / cleanup indexes (Plan Part 16 + ADR 0005 reconciliation).
    expect(indexUniqueness(attachments).get("attachments_note_id_idx")).toBe(false);
    expect(indexUniqueness(attachments).get("attachments_workspace_id_idx")).toBe(false);
    expect(indexUniqueness(attachments).get("attachments_workspace_status_idx")).toBe(false);
    expect(indexUniqueness(attachments).get("attachments_created_by_id_idx")).toBe(false);
  });

  it("declares comments with selection anchors (ADR 0004) and thread self-reference", () => {
    const cols = new Map(getTableConfig(comments).columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "note_id",
      "parent_id",
      "content",
      "created_by_id",
      "is_resolved",
      "resolved_at",
      "resolved_by_id",
      "anchor_key",
      "anchor_from",
      "anchor_to",
      "anchor_metadata",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `comments.${name}`).toBe(true);
    }

    // Core nullability.
    expect(cols.get("note_id")?.notNull).toBe(true);
    expect(cols.get("parent_id")?.notNull).toBe(false);
    expect(cols.get("content")?.notNull).toBe(true);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
    expect(cols.get("is_resolved")?.notNull).toBe(true);
    // Resolution + resolver.
    expect(cols.get("resolved_at")?.notNull).toBe(false);
    expect(cols.get("resolved_by_id")?.notNull).toBe(false);
    // All anchor columns are nullable (whole-note comment without selection).
    expect(cols.get("anchor_key")?.notNull).toBe(false);
    expect(cols.get("anchor_from")?.notNull).toBe(false);
    expect(cols.get("anchor_to")?.notNull).toBe(false);
    expect(cols.get("anchor_metadata")?.notNull).toBe(false);

    // Indexes: note lookup, resolved filter, thread lookup, creator.
    expect(indexUniqueness(comments).get("comments_note_id_idx")).toBe(false);
    expect(indexUniqueness(comments).get("comments_note_resolved_idx")).toBe(false);
    expect(indexUniqueness(comments).get("comments_parent_id_idx")).toBe(false);
    expect(indexUniqueness(comments).get("comments_created_by_id_idx")).toBe(false);
  });

  it("declares note_versions with the snapshot model (distinct from notes.version)", () => {
    const cols = new Map(getTableConfig(noteVersions).columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "note_id",
      "version",
      "title",
      "content",
      "content_plain",
      "created_by_id",
      "created_at",
    ]) {
      expect(cols.has(name), `note_versions.${name}`).toBe(true);
    }

    // title + content NOT NULL so restore reproduces the whole note.
    expect(cols.get("note_id")?.notNull).toBe(true);
    expect(cols.get("version")?.notNull).toBe(true);
    expect(cols.get("title")?.notNull).toBe(true);
    expect(cols.get("content")?.notNull).toBe(true);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
    expect(cols.get("content_plain")?.notNull).toBe(false);

    // Ordered retrieval + per-version + creator indexes.
    expect(indexUniqueness(noteVersions).get("note_versions_note_created_idx")).toBe(false);
    expect(indexUniqueness(noteVersions).get("note_versions_note_version_unique")).toBe(true);
    expect(indexUniqueness(noteVersions).get("note_versions_created_by_id_idx")).toBe(false);
  });

  it("uses the intended cascade/restrict/set-null behavior on every foreign key", () => {
    const tagFks = fkOnDelete(tags);
    expect(tagFks.get("tags_workspace_id_workspaces_id_fk")).toBe("cascade");

    const ntFks = fkOnDelete(noteTags);
    expect(ntFks.get("note_tags_note_id_notes_id_fk")).toBe("cascade");
    expect(ntFks.get("note_tags_tag_id_tags_id_fk")).toBe("cascade");

    const attFks = fkOnDelete(attachments);
    expect(attFks.get("attachments_note_id_notes_id_fk")).toBe("cascade");
    expect(attFks.get("attachments_workspace_id_workspaces_id_fk")).toBe("cascade");
    expect(attFks.get("attachments_created_by_id_users_id_fk")).toBe("restrict");

    const cFks = fkOnDelete(comments);
    expect(cFks.get("comments_note_id_notes_id_fk")).toBe("cascade");
    // Self-reference cascade for threaded replies.
    expect(cFks.get("comments_parent_id_comments_id_fk")).toBe("cascade");
    expect(cFks.get("comments_created_by_id_users_id_fk")).toBe("restrict");
    expect(cFks.get("comments_resolved_by_id_users_id_fk")).toBe("set null");

    const nvFks = fkOnDelete(noteVersions);
    expect(nvFks.get("note_versions_note_id_notes_id_fk")).toBe("cascade");
    expect(nvFks.get("note_versions_created_by_id_users_id_fk")).toBe("restrict");
  });
});

// ----------------------------------------------------------------------------
// Live migration test (DATABASE_URL-gated). Follows the same skip pattern as
// `database.migration.test.ts` and `notes-projects-schema.test.ts` so it is
// inert in CI without a database and skips cleanly when dev compose is not
// running. Each live test creates deterministic unique fixtures and cleans up
// via the workspace cascade in a finally block.
// ----------------------------------------------------------------------------

async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {
      /* connection cleanup is best-effort during the reachability probe */
    });
  }
}

/** Creates deterministic user + workspace + owner membership and returns their ids. */
async function bootstrapTenant(
  db: NodePgDatabase,
  stamp: string,
  label: string,
): Promise<{ userId: string; workspaceId: string }> {
  const email = `p16-${label}-${stamp}@notted.invalid`;
  const slug = `p16-${label}-${stamp}`;

  const user = await db.execute(sql`
    insert into users (email, name) values (${email}, ${`Part16 ${label}`})
    returning id
  `);
  const userId = (user.rows[0] as { id: string }).id;

  const workspace = await db.execute(sql`
    insert into workspaces (name, slug, created_by_id)
    values (${"Part16 " + label}, ${slug}, ${userId})
    returning id
  `);
  const workspaceId = (workspace.rows[0] as { id: string }).id;

  await db.execute(sql`
    insert into workspace_members (workspace_id, user_id, role)
    values (${workspaceId}, ${userId}, 'owner')
  `);

  return { userId, workspaceId };
}

describe.skipIf(!HAS_DATABASE_URL)(
  "tags, attachments, comments, and note versions schema (live)",
  () => {
    let pool: Pool | undefined;
    let db: NodePgDatabase | undefined;
    let reachable = false;

    beforeAll(async () => {
      reachable = await isDatabaseReachable(DATABASE_URL as string);
      if (!reachable) {
        return;
      }
      pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
      const database = drizzle(pool);
      db = database;
      await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    });

    afterAll(async () => {
      if (pool !== undefined) {
        await pool.end().catch(() => {
          /* pool shutdown is best-effort during teardown */
        });
      }
    });

    it("creates the Part 16 tables and enums", async ({ skip }) => {
      if (!reachable || db === undefined) {
        skip("skipped: no reachable PostgreSQL — run dev compose");
        return;
      }

      const tables = (
        await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('tags', 'note_tags', 'attachments', 'comments', 'note_versions')
        order by table_name
      `)
      ).rows as unknown as ReadonlyArray<{ table_name: string }>;

      expect(tables.map((row) => row.table_name)).toEqual([
        "attachments",
        "comments",
        "note_tags",
        "note_versions",
        "tags",
      ]);

      const enumTypes = (
        await db.execute(sql`
        select t.typname, e.enumlabel
        from pg_type t
        join pg_enum e on t.oid = e.enumtypid
        where t.typname in ('attachment_status', 'attachment_media_type')
        order by t.typname, e.enumsortorder
      `)
      ).rows as unknown as ReadonlyArray<{ typname: string; enumlabel: string }>;

      const byType = new Map<string, string[]>();
      for (const row of enumTypes) {
        const list = byType.get(row.typname) ?? [];
        list.push(row.enumlabel);
        byType.set(row.typname, list);
      }
      expect(byType.get("attachment_status")).toEqual(["pending", "processing", "ready", "failed"]);
      expect(byType.get("attachment_media_type")).toEqual(["image", "file"]);
    });

    it("(a) assigns tags via note_tags and rejects a duplicate (note, tag) by composite PK", async ({
      skip,
    }) => {
      if (!reachable || db === undefined) {
        skip("skipped: no reachable PostgreSQL — run dev compose");
        return;
      }

      const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const { userId, workspaceId } = await bootstrapTenant(db, stamp, "tag");

      try {
        const note = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id)
        values (${workspaceId}, ${"Tagged note " + stamp}, ${userId})
        returning id
      `);
        const noteId = (note.rows[0] as { id: string }).id;

        // Two distinct tags in the workspace.
        const tagA = await db.execute(sql`
        insert into tags (workspace_id, name)
        values (${workspaceId}, ${"urgent " + stamp})
        returning id
      `);
        const tagAId = (tagA.rows[0] as { id: string }).id;
        const tagB = await db.execute(sql`
        insert into tags (workspace_id, name)
        values (${workspaceId}, ${"draft " + stamp})
        returning id
      `);
        const tagBId = (tagB.rows[0] as { id: string }).id;

        // Unique workspace tag name: a duplicate name in the same workspace is
        // rejected with a unique violation.
        await expectPostgresErrorCode(
          db.execute(sql`
          insert into tags (workspace_id, name)
          values (${workspaceId}, ${"urgent " + stamp})
        `),
          PG_UNIQUE_VIOLATION,
        );

        // Assign both tags to the note via the junction.
        await db.execute(sql`
        insert into note_tags (note_id, tag_id) values (${noteId}, ${tagAId})
      `);
        await db.execute(sql`
        insert into note_tags (note_id, tag_id) values (${noteId}, ${tagBId})
      `);

        // Composite PK rejects a duplicate (note, tag) assignment.
        await expectPostgresErrorCode(
          db.execute(sql`
          insert into note_tags (note_id, tag_id) values (${noteId}, ${tagAId})
        `),
          PG_UNIQUE_VIOLATION,
        );

        // "Notes with tag X" reverse lookup returns exactly the one note.
        const withTagA = await db.execute(sql`
        select note_id from note_tags where tag_id = ${tagAId}
      `);
        expect((withTagA.rows as unknown as { note_id: string }[]).map((r) => r.note_id)).toEqual([
          noteId,
        ]);

        // Deleting the tag cascades to its note_tags assignments.
        await db.execute(sql`delete from tags where id = ${tagAId}`);
        const leftover = await db.execute(
          sql`select note_id from note_tags where tag_id = ${tagAId}`,
        );
        expect(leftover.rows).toHaveLength(0);
      } finally {
        await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
        await db.execute(sql`delete from users where id = ${userId}`);
      }
    });

    it("(b) cascades threaded comment deletion and note deletion to comments", async ({ skip }) => {
      if (!reachable || db === undefined) {
        skip("skipped: no reachable PostgreSQL — run dev compose");
        return;
      }

      const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const { userId, workspaceId } = await bootstrapTenant(db, stamp, "cmt");

      try {
        const note = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id)
        values (${workspaceId}, ${"Commented note " + stamp}, ${userId})
        returning id
      `);
        const noteId = (note.rows[0] as { id: string }).id;

        // Top-level comment with a selection anchor.
        const parent = await db.execute(sql`
        insert into comments (note_id, content, created_by_id, anchor_key, anchor_from, anchor_to)
        values (${noteId}, ${"Parent " + stamp}, ${userId}, ${"para-3"}, 10, 24)
        returning id
      `);
        const parentId = (parent.rows[0] as { id: string }).id;

        // Two replies on the parent (threaded).
        await db.execute(sql`
        insert into comments (note_id, parent_id, content, created_by_id)
        values (${noteId}, ${parentId}, ${"Reply 1 " + stamp}, ${userId})
      `);
        await db.execute(sql`
        insert into comments (note_id, parent_id, content, created_by_id)
        values (${noteId}, ${parentId}, ${"Reply 2 " + stamp}, ${userId})
      `);

        // A second whole-note comment without a selection anchor.
        await db.execute(sql`
        insert into comments (note_id, content, created_by_id)
        values (${noteId}, ${"Standalone " + stamp}, ${userId})
      `);

        const before = await db.execute(
          sql`select count(*)::int as c from comments where note_id = ${noteId}`,
        );
        expect((before.rows[0] as { c: number }).c).toBe(4);

        // Deleting the parent comment cascades to its two replies.
        await db.execute(sql`delete from comments where id = ${parentId}`);
        const afterParent = await db.execute(
          sql`select count(*)::int as c from comments where note_id = ${noteId}`,
        );
        expect((afterParent.rows[0] as { c: number }).c).toBe(1);

        // Deleting the note cascades to ALL remaining comments on it.
        await db.execute(sql`delete from notes where id = ${noteId}`);
        const afterNote = await db.execute(
          sql`select count(*)::int as c from comments where note_id = ${noteId}`,
        );
        expect((afterNote.rows[0] as { c: number }).c).toBe(0);
      } finally {
        await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
        await db.execute(sql`delete from users where id = ${userId}`);
      }
    });

    it("(c) returns the expected rows for the attachment cleanup-by-status lookup", async ({
      skip,
    }) => {
      if (!reachable || db === undefined) {
        skip("skipped: no reachable PostgreSQL — run dev compose");
        return;
      }
      const liveDb = db;

      const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const { userId, workspaceId } = await bootstrapTenant(liveDb, stamp, "att");

      try {
        const note = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id)
        values (${workspaceId}, ${"Attach note " + stamp}, ${userId})
        returning id
      `);
        const noteId = (note.rows[0] as { id: string }).id;

        // Two pending (need upload/cleanup), one ready, one failed (needs cleanup).
        const insertAttachment = (status: string, key: string) =>
          liveDb.execute(sql`
        insert into attachments (
          note_id, workspace_id, original_name, filename, mime_type,
          size_bytes, storage_key, created_by_id, processing_status
        )
        values (
          ${noteId}, ${workspaceId}, ${"f-" + key + "-" + stamp}, ${"f-" + key + "-" + stamp},
          ${"application/octet-stream"}, 1024, ${"opaque/key/" + key + "/" + stamp},
          ${userId}, ${status}::attachment_status
        )
      `);
        await insertAttachment("pending", "p1");
        await insertAttachment("pending", "p2");
        await insertAttachment("ready", "r1");
        await insertAttachment("failed", "f1");

        // Orphan/cleanup lookup by status within the workspace: pending rows.
        const pending = await db.execute(sql`
        select id from attachments
        where workspace_id = ${workspaceId} and processing_status = 'pending'
      `);
        expect(pending.rows).toHaveLength(2);

        // Failed rows (object cleanup enqueued after commit per ADR 0005).
        const failed = await db.execute(sql`
        select id from attachments
        where workspace_id = ${workspaceId} and processing_status = 'failed'
      `);
        expect(failed.rows).toHaveLength(1);

        // The full workspace status breakdown.
        const breakdown = await db.execute(sql`
        select processing_status, count(*)::int as c
        from attachments
        where workspace_id = ${workspaceId}
        group by processing_status
        order by processing_status
      `);
        const byStatus = new Map(
          (breakdown.rows as unknown as Array<{ processing_status: string; c: number }>).map(
            (r) => [r.processing_status, r.c],
          ),
        );
        expect(byStatus.get("pending")).toBe(2);
        expect(byStatus.get("ready")).toBe(1);
        expect(byStatus.get("failed")).toBe(1);
      } finally {
        await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
        await db.execute(sql`delete from users where id = ${userId}`);
      }
    });

    it("(d) returns note versions in descending order for ordered retrieval", async ({ skip }) => {
      if (!reachable || db === undefined) {
        skip("skipped: no reachable PostgreSQL — run dev compose");
        return;
      }

      const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const { userId, workspaceId } = await bootstrapTenant(db, stamp, "ver");

      try {
        const note = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, version)
        values (${workspaceId}, ${"Versioned note " + stamp}, ${userId}, 3)
        returning id
      `);
        const noteId = (note.rows[0] as { id: string }).id;

        // Three explicit snapshots with deterministic timestamps and the matching
        // notes.version value at capture time. Title captured at snapshot time so
        // restore reproduces the whole note.
        await db.execute(sql`
        insert into note_versions (note_id, version, title, content, content_plain, created_by_id, created_at)
        values (${noteId}, 1, ${"Title v1 " + stamp}, ${JSON.stringify({ type: "doc", content: [] })}::jsonb, ${"alpha " + stamp}, ${userId}, ${"2026-01-01T00:00:00+00:00"}::timestamptz)
      `);
        await expectPostgresErrorCode(
          db.execute(sql`
          insert into note_versions (note_id, version, title, content, created_by_id)
          values (${noteId}, 1, ${"Duplicate v1 " + stamp}, ${JSON.stringify({ type: "doc", content: [] })}::jsonb, ${userId})
        `),
          PG_UNIQUE_VIOLATION,
        );
        await db.execute(sql`
        insert into note_versions (note_id, version, title, content, content_plain, created_by_id, created_at)
        values (${noteId}, 2, ${"Title v2 " + stamp}, ${JSON.stringify({ type: "doc", content: [] })}::jsonb, ${"beta " + stamp}, ${userId}, ${"2026-01-02T00:00:00+00:00"}::timestamptz)
      `);
        await db.execute(sql`
        insert into note_versions (note_id, version, title, content, content_plain, created_by_id, created_at)
        values (${noteId}, 3, ${"Title v3 " + stamp}, ${JSON.stringify({ type: "doc", content: [] })}::jsonb, ${"gamma " + stamp}, ${userId}, ${"2026-01-03T00:00:00+00:00"}::timestamptz)
      `);

        // Ordered retrieval by created_at DESC (newest first) — the hot path for
        // the history UI. The btree index note_versions_note_created_idx supports
        // a reverse scan.
        const byCreated = await db.execute(sql`
        select version from note_versions
        where note_id = ${noteId}
        order by created_at desc
      `);
        expect((byCreated.rows as unknown as { version: number }[]).map((r) => r.version)).toEqual([
          3, 2, 1,
        ]);

        // Ordered retrieval by version DESC (restore-by-version path).
        const byVersion = await db.execute(sql`
        select title from note_versions
        where note_id = ${noteId}
        order by version desc
      `);
        expect((byVersion.rows as unknown as { title: string }[]).map((r) => r.title)).toEqual([
          `Title v3 ${stamp}`,
          `Title v2 ${stamp}`,
          `Title v1 ${stamp}`,
        ]);

        // Cascades: deleting the note removes its version snapshots.
        await db.execute(sql`delete from notes where id = ${noteId}`);
        const leftover = await db.execute(
          sql`select id from note_versions where note_id = ${noteId}`,
        );
        expect(leftover.rows).toHaveLength(0);
      } finally {
        await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
        await db.execute(sql`delete from users where id = ${userId}`);
      }
    });
  },
);
