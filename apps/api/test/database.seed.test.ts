import { resolve } from "node:path";

import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Database, type DatabaseTransaction } from "../src/database/database.service";
import {
  attachments,
  auditLogs,
  comments,
  folders,
  noteTags,
  noteVersions,
  notes,
  projects,
  schema,
  tags,
  taskStatuses,
  taskTags,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} from "../src/database/schema";
import {
  RICH_CONTENT_PLAIN,
  RICH_TIPTAP_DOCUMENT,
  SEED_EXPECTED_COUNTS,
  SEED_IDENTITIES,
  SEED_IDS,
  SEED_SCENARIOS,
  assertSafeSeedTarget,
  seedDatabase,
} from "../src/database/seed";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u;

class RollbackSeedTest extends Error {}

function allSeedIds(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap((entry) => allSeedIds(entry));
}

function tipTapText(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const node = value as { content?: unknown; text?: unknown };
  const ownText = typeof node.text === "string" ? [node.text] : [];
  const childText = Array.isArray(node.content)
    ? node.content.flatMap((child) => tipTapText(child))
    : [];
  return [...ownText, ...childText];
}

async function deterministicCounts(tx: DatabaseTransaction) {
  const noteTagPredicate = or(
    and(
      eq(noteTags.noteId, SEED_IDS.notes.alphaPinnedRoot),
      eq(noteTags.tagId, SEED_IDS.tags.alphaPlanning),
    ),
    and(
      eq(noteTags.noteId, SEED_IDS.notes.alphaProjectOverview),
      eq(noteTags.tagId, SEED_IDS.tags.alphaPlanning),
    ),
    and(
      eq(noteTags.noteId, SEED_IDS.notes.alphaProjectOverview),
      eq(noteTags.tagId, SEED_IDS.tags.alphaUrgent),
    ),
    and(
      eq(noteTags.noteId, SEED_IDS.notes.betaRoot),
      eq(noteTags.tagId, SEED_IDS.tags.betaResearch),
    ),
  );
  const taskTagPredicate = or(
    and(
      eq(taskTags.taskId, SEED_IDS.tasks.alphaPrepareLaunch),
      eq(taskTags.tagId, SEED_IDS.tags.alphaUrgent),
    ),
    and(
      eq(taskTags.taskId, SEED_IDS.tasks.alphaStandaloneFollowUp),
      eq(taskTags.tagId, SEED_IDS.tags.alphaPlanning),
    ),
  );

  // One PostgreSQL transaction owns one client. Run queries sequentially;
  // concurrent client.query calls are deprecated by `pg` and can race.
  const userRows = await tx
    .select({ value: count() })
    .from(users)
    .where(inArray(users.id, Object.values(SEED_IDS.users)));
  const workspaceRows = await tx
    .select({ value: count() })
    .from(workspaces)
    .where(inArray(workspaces.id, Object.values(SEED_IDS.workspaces)));
  const memberRows = await tx
    .select({ value: count() })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.id, Object.values(SEED_IDS.memberships)));
  const projectRows = await tx
    .select({ value: count() })
    .from(projects)
    .where(inArray(projects.id, Object.values(SEED_IDS.projects)));
  const folderRows = await tx
    .select({ value: count() })
    .from(folders)
    .where(inArray(folders.id, Object.values(SEED_IDS.folders)));
  const noteRows = await tx
    .select({ value: count() })
    .from(notes)
    .where(inArray(notes.id, Object.values(SEED_IDS.notes)));
  const tagRows = await tx
    .select({ value: count() })
    .from(tags)
    .where(inArray(tags.id, Object.values(SEED_IDS.tags)));
  const noteTagRows = await tx.select({ value: count() }).from(noteTags).where(noteTagPredicate);
  const commentRows = await tx
    .select({ value: count() })
    .from(comments)
    .where(inArray(comments.id, Object.values(SEED_IDS.comments)));
  const versionRows = await tx
    .select({ value: count() })
    .from(noteVersions)
    .where(inArray(noteVersions.id, Object.values(SEED_IDS.noteVersions)));
  const attachmentRows = await tx
    .select({ value: count() })
    .from(attachments)
    .where(inArray(attachments.id, Object.values(SEED_IDS.attachments)));
  const statusRows = await tx
    .select({ value: count() })
    .from(taskStatuses)
    .where(inArray(taskStatuses.id, Object.values(SEED_IDS.taskStatuses)));
  const taskRows = await tx
    .select({ value: count() })
    .from(tasks)
    .where(inArray(tasks.id, Object.values(SEED_IDS.tasks)));
  const taskTagRows = await tx.select({ value: count() }).from(taskTags).where(taskTagPredicate);
  const auditLogRows = await tx
    .select({ value: count() })
    .from(auditLogs)
    .where(inArray(auditLogs.id, Object.values(SEED_IDS.auditLogs)));

  return {
    users: userRows[0]?.value ?? 0,
    workspaces: workspaceRows[0]?.value ?? 0,
    workspaceMembers: memberRows[0]?.value ?? 0,
    projects: projectRows[0]?.value ?? 0,
    folders: folderRows[0]?.value ?? 0,
    notes: noteRows[0]?.value ?? 0,
    tags: tagRows[0]?.value ?? 0,
    noteTags: noteTagRows[0]?.value ?? 0,
    comments: commentRows[0]?.value ?? 0,
    noteVersions: versionRows[0]?.value ?? 0,
    attachments: attachmentRows[0]?.value ?? 0,
    taskStatuses: statusRows[0]?.value ?? 0,
    tasks: taskRows[0]?.value ?? 0,
    taskTags: taskTagRows[0]?.value ?? 0,
    auditLogs: auditLogRows[0]?.value ?? 0,
  };
}

describe("Part 20 deterministic seed fixtures (unit)", () => {
  const target = (databaseName: string, overrides: Partial<NodeJS.ProcessEnv> = {}) => ({
    NODE_ENV: "development",
    DATABASE_URL: `postgresql://seed-user:seed-password@localhost:5432/${databaseName}`,
    ...overrides,
  });

  it.each(["notted_dev", "notted_test", "notted_test_42", "notted_review", "notted_phase3_review"])(
    "allows the documented non-production seed target %s",
    (databaseName) => {
      expect(() => assertSafeSeedTarget(target(databaseName))).not.toThrow();
    },
  );

  it("rejects production even when the unsafe-name override is set", () => {
    expect(() =>
      assertSafeSeedTarget(
        target("notted_dev", {
          NODE_ENV: "production",
          ALLOW_UNSAFE_DATABASE_SEED: "true",
        }),
      ),
    ).toThrow(/NODE_ENV=production/u);
  });

  it("rejects an arbitrary database name by default", () => {
    expect(() => assertSafeSeedTarget(target("customer_primary"))).toThrow(
      /unapproved target name/u,
    );
  });

  it("rejects production-like names even when they contain a review segment", () => {
    expect(() => assertSafeSeedTarget(target("production_review"))).toThrow(
      /unapproved target name/u,
    );
  });

  it("allows an exceptional non-production target only with the exact override", () => {
    expect(() =>
      assertSafeSeedTarget(target("local_scratch", { ALLOW_UNSAFE_DATABASE_SEED: "true" })),
    ).not.toThrow();
    expect(() =>
      assertSafeSeedTarget(target("local_scratch", { ALLOW_UNSAFE_DATABASE_SEED: "TRUE" })),
    ).toThrow(/unapproved target name/u);
  });

  it("exports unique deterministic UUIDs and reserved-domain identities", () => {
    const ids = allSeedIds(SEED_IDS);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids.every((id) => UUID_PATTERN.test(id))).toBe(true);
    expect(
      Object.values(SEED_IDENTITIES).every(({ email }) => email.endsWith("@notted.test")),
    ).toBe(true);
    expect(SEED_SCENARIOS.alpha.workspaceSlug).not.toBe(SEED_SCENARIOS.beta.workspaceSlug);
  });

  it("keeps the rich TipTap projection and matching plain-text fixture explicit", () => {
    expect(RICH_TIPTAP_DOCUMENT.type).toBe("doc");
    expect(RICH_TIPTAP_DOCUMENT.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
    ]);
    expect(tipTapText(RICH_TIPTAP_DOCUMENT).join("\n")).toBe(RICH_CONTENT_PLAIN);
  });
});

describe.skipIf(!HAS_DATABASE)("Part 20 deterministic seed (live)", () => {
  let pool: Pool | undefined;
  let db: Database | undefined;

  beforeAll(async () => {
    await requireDatabase();
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    const database = drizzle(pool, { schema });
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

  it("reseeds atomically without duplicates and keeps both scenarios browsable and isolated", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        const firstResult = await seedDatabase(tx);
        const firstCounts = await deterministicCounts(tx);
        const secondResult = await seedDatabase(tx);
        const secondCounts = await deterministicCounts(tx);

        expect(firstResult.counts).toEqual(SEED_EXPECTED_COUNTS);
        expect(secondResult).toEqual(firstResult);
        expect(firstCounts).toEqual(SEED_EXPECTED_COUNTS);
        expect(secondCounts).toEqual(firstCounts);

        const alphaMembers = await tx
          .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, SEED_IDS.workspaces.alpha),
              inArray(workspaceMembers.id, [
                SEED_IDS.memberships.alphaOwner,
                SEED_IDS.memberships.alphaAdmin,
                SEED_IDS.memberships.alphaEditor,
                SEED_IDS.memberships.alphaViewer,
              ]),
            ),
          );
        expect(alphaMembers.map(({ role }) => role).sort()).toEqual([
          "admin",
          "editor",
          "owner",
          "viewer",
        ]);
        expect(alphaMembers.map(({ userId }) => userId)).not.toContain(SEED_IDS.users.betaOwner);

        const betaMembers = await tx
          .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, SEED_IDS.workspaces.beta),
              inArray(workspaceMembers.id, [
                SEED_IDS.memberships.betaOwner,
                SEED_IDS.memberships.betaEditor,
              ]),
            ),
          );
        expect(betaMembers).toHaveLength(2);
        expect(betaMembers.map(({ userId }) => userId)).not.toContain(SEED_IDS.users.alphaOwner);

        const alphaProjects = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.workspaceId, SEED_IDS.workspaces.alpha));
        const betaProjects = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.workspaceId, SEED_IDS.workspaces.beta));
        expect(alphaProjects.map(({ id }) => id)).toEqual(
          expect.arrayContaining([
            SEED_IDS.projects.alphaLaunch,
            SEED_IDS.projects.alphaOperations,
          ]),
        );
        expect(betaProjects.map(({ id }) => id)).toContain(SEED_IDS.projects.betaResearch);
        expect(alphaProjects.map(({ id }) => id)).not.toContain(SEED_IDS.projects.betaResearch);

        const seededNotes = await tx
          .select()
          .from(notes)
          .where(inArray(notes.id, Object.values(SEED_IDS.notes)));
        const noteById = new Map(seededNotes.map((note) => [note.id, note]));
        expect(noteById.get(SEED_IDS.notes.alphaPinnedRoot)).toMatchObject({
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: null,
          parentId: null,
          isPinned: true,
        });
        expect(noteById.get(SEED_IDS.notes.alphaProjectOverview)).toMatchObject({
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: SEED_IDS.projects.alphaLaunch,
          contentPlain: RICH_CONTENT_PLAIN,
          version: 3,
        });
        expect(noteById.get(SEED_IDS.notes.alphaProjectChild)).toMatchObject({
          parentId: SEED_IDS.notes.alphaProjectOverview,
          projectId: SEED_IDS.projects.alphaLaunch,
        });
        expect(noteById.get(SEED_IDS.notes.alphaFolderNote)).toMatchObject({
          folderId: SEED_IDS.folders.alphaPlaybooks,
          projectId: null,
        });
        expect(noteById.get(SEED_IDS.notes.alphaTemplate)).toMatchObject({
          isTemplate: true,
          parentId: null,
        });
        expect(noteById.get(SEED_IDS.notes.alphaDeleted)).toMatchObject({
          isDeleted: true,
        });
        expect(noteById.get(SEED_IDS.notes.alphaDeleted)?.deletedAt).toBeInstanceOf(Date);
        expect(noteById.get(SEED_IDS.notes.betaRoot)?.workspaceId).toBe(SEED_IDS.workspaces.beta);
        expect(
          seededNotes.filter(({ workspaceId }) => workspaceId === SEED_IDS.workspaces.alpha),
        ).toHaveLength(7);
        expect(
          seededNotes.filter(({ workspaceId }) => workspaceId === SEED_IDS.workspaces.beta),
        ).toHaveLength(2);

        const nestedFolder = await tx
          .select()
          .from(folders)
          .where(eq(folders.id, SEED_IDS.folders.alphaPlaybooks));
        expect(nestedFolder[0]).toMatchObject({
          workspaceId: SEED_IDS.workspaces.alpha,
          parentId: SEED_IDS.folders.alphaHandbook,
        });

        const overviewTags = await tx
          .select({ noteId: noteTags.noteId, tagId: noteTags.tagId })
          .from(noteTags)
          .where(eq(noteTags.noteId, SEED_IDS.notes.alphaProjectOverview));
        expect(overviewTags).toEqual(
          expect.arrayContaining([
            {
              noteId: SEED_IDS.notes.alphaProjectOverview,
              tagId: SEED_IDS.tags.alphaPlanning,
            },
            {
              noteId: SEED_IDS.notes.alphaProjectOverview,
              tagId: SEED_IDS.tags.alphaUrgent,
            },
          ]),
        );

        const thread = await tx
          .select()
          .from(comments)
          .where(inArray(comments.id, Object.values(SEED_IDS.comments)));
        const parentComment = thread.find(({ id }) => id === SEED_IDS.comments.alphaThread);
        const reply = thread.find(({ id }) => id === SEED_IDS.comments.alphaReply);
        expect(parentComment).toMatchObject({
          noteId: SEED_IDS.notes.alphaProjectOverview,
          anchorKey: "launch-overview-goals",
          anchorFrom: 0,
          anchorTo: 17,
        });
        expect(reply?.parentId).toBe(SEED_IDS.comments.alphaThread);

        const versions = await tx
          .select({ version: noteVersions.version, title: noteVersions.title })
          .from(noteVersions)
          .where(
            and(
              eq(noteVersions.noteId, SEED_IDS.notes.alphaProjectOverview),
              inArray(noteVersions.id, Object.values(SEED_IDS.noteVersions)),
            ),
          )
          .orderBy(asc(noteVersions.version));
        expect(versions.map(({ version }) => version)).toEqual([1, 2, 3]);
        expect(versions[2]?.title).toBe("Launch overview");

        const attachment = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.id, SEED_IDS.attachments.alphaBrief));
        expect(attachment[0]).toMatchObject({
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: SEED_IDS.notes.alphaProjectOverview,
          filename: "launch-brief.pdf",
          mimeType: "application/pdf",
          sizeBytes: 184_320,
          processingStatus: "ready",
        });
        expect(attachment[0]?.storageKey).not.toMatch(/^https?:/u);
        expect(attachment[0]?.variants).toMatchObject({ preview: { width: 320, height: 452 } });

        expect(noteById.get(SEED_IDS.notes.alphaTaskNote)).toMatchObject({
          noteType: "task",
          projectId: SEED_IDS.projects.alphaOperations,
        });
        const seededTasks = await tx
          .select()
          .from(tasks)
          .where(inArray(tasks.id, Object.values(SEED_IDS.tasks)));
        const taskById = new Map(seededTasks.map((task) => [task.id, task]));
        expect(taskById.get(SEED_IDS.tasks.alphaPrepareLaunch)).toMatchObject({
          noteId: SEED_IDS.notes.alphaTaskNote,
          status: "in_progress",
          priority: "high",
          recurrence: "weekly",
          assigneeId: SEED_IDS.users.alphaEditor,
          sortOrder: 1,
        });
        expect(taskById.get(SEED_IDS.tasks.alphaConfirmCopy)).toMatchObject({
          parentId: SEED_IDS.tasks.alphaPrepareLaunch,
          customStatusId: SEED_IDS.taskStatuses.alphaReview,
          priority: "urgent",
        });
        expect(taskById.get(SEED_IDS.tasks.alphaPublishNotes)).toMatchObject({ status: "done" });
        expect(taskById.get(SEED_IDS.tasks.alphaPublishNotes)?.completedAt).toBeInstanceOf(Date);
        expect(taskById.get(SEED_IDS.tasks.alphaStandaloneFollowUp)).toMatchObject({
          noteId: null,
          projectId: null,
          recurrence: "custom",
          recurrenceCron: "0 9 * * 1",
          sortOrder: 3,
        });

        const customStatus = await tx
          .select()
          .from(taskStatuses)
          .where(eq(taskStatuses.id, SEED_IDS.taskStatuses.alphaReview));
        expect(customStatus[0]).toMatchObject({
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: SEED_IDS.projects.alphaOperations,
          name: "Needs review",
          isBuiltIn: false,
        });

        const seededTaskTags = await tx
          .select()
          .from(taskTags)
          .where(inArray(taskTags.taskId, Object.values(SEED_IDS.tasks)));
        expect(seededTaskTags).toEqual(
          expect.arrayContaining([
            { taskId: SEED_IDS.tasks.alphaPrepareLaunch, tagId: SEED_IDS.tags.alphaUrgent },
            {
              taskId: SEED_IDS.tasks.alphaStandaloneFollowUp,
              tagId: SEED_IDS.tags.alphaPlanning,
            },
          ]),
        );

        throw new RollbackSeedTest("rollback deterministic seed fixture test");
      }),
    ).rejects.toBeInstanceOf(RollbackSeedTest);
  });
});
