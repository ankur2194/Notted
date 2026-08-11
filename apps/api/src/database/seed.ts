import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  attachments,
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
} from "./schema";
import {
  RICH_CONTENT_PLAIN,
  RICH_TIPTAP_DOCUMENT,
  SEED_EXPECTED_COUNTS,
  SEED_IDENTITIES,
  SEED_IDS,
  SEED_SCENARIOS,
  SEED_TIMESTAMPS,
  TASK_CONTENT_PLAIN,
  TASK_TIPTAP_DOCUMENT,
} from "./seed-fixtures";

import type { DatabaseTransaction } from "./database.service";

export {
  RICH_CONTENT_PLAIN,
  RICH_TIPTAP_DOCUMENT,
  SEED_EXPECTED_COUNTS,
  SEED_IDENTITIES,
  SEED_IDS,
  SEED_SCENARIOS,
  SEED_TIMESTAMPS,
  TASK_CONTENT_PLAIN,
  TASK_TIPTAP_DOCUMENT,
} from "./seed-fixtures";

export interface SeedResult {
  readonly scenarios: readonly string[];
  readonly counts: typeof SEED_EXPECTED_COUNTS;
}

interface SeedDatabaseClient {
  transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
}

class SeedSetupError extends Error {}

export interface SeedTargetEnvironment {
  readonly NODE_ENV?: string;
  readonly DATABASE_URL?: string;
  readonly ALLOW_UNSAFE_DATABASE_SEED?: string;
}

const SAFE_SEED_DATABASE_NAME = "notted_dev";
const PROJECT_TEST_OR_REVIEW_DATABASE_NAME =
  /^notted_(?:[a-z0-9]+_)*(?:test|review)(?:_[a-z0-9]+)*$/u;

/**
 * Refuse accidental production/arbitrary database seeding without ever
 * returning or logging a connection URL. Production is unconditionally
 * denied; the explicit override applies only to exceptional non-production
 * targets.
 */
export function assertSafeSeedTarget(environment: SeedTargetEnvironment): void {
  if (environment.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new SeedSetupError("Database seed refused while NODE_ENV=production.");
  }

  const connectionString = environment.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString === "") {
    throw new SeedSetupError(
      "DATABASE_URL is required. Create apps/api/.env and run migrations before seeding.",
    );
  }

  let databaseName: string;
  try {
    const parsed = new URL(connectionString);
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  } catch {
    throw new SeedSetupError("Database seed refused because DATABASE_URL is invalid.");
  }

  if (databaseName === "") {
    throw new SeedSetupError("Database seed refused because the target database name is empty.");
  }

  const isSafeName =
    databaseName === SAFE_SEED_DATABASE_NAME ||
    PROJECT_TEST_OR_REVIEW_DATABASE_NAME.test(databaseName);
  if (!isSafeName && environment.ALLOW_UNSAFE_DATABASE_SEED !== "true") {
    throw new SeedSetupError(
      "Database seed refused for an unapproved target name. Use notted_dev, a project-prefixed notted_*_test/notted_*_review database, or set ALLOW_UNSAFE_DATABASE_SEED=true for an exceptional non-production target.",
    );
  }
}

function fixedDate(value: string): Date {
  return new Date(value);
}

function simpleDocument(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  } as const;
}

function withoutId<T extends { readonly id: string }>(row: T): Omit<T, "id"> {
  const { id, ...values } = row;
  void id;
  return values;
}

function isMigrationProbeRow(value: unknown): value is { ready: boolean } {
  return (
    typeof value === "object" && value !== null && (value as { ready?: unknown }).ready === true
  );
}

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function safeSeedErrorMessage(error: unknown): string {
  if (error instanceof SeedSetupError) {
    return error.message;
  }

  switch (databaseErrorCode(error)) {
    case "42P01":
    case "42704":
      return "Database seed failed because migrations 0000-0007 have not been applied.";
    case "23503":
      return "Database seed failed because a required deterministic parent relationship is missing.";
    case "23505":
      return "Database seed found a conflicting reserved fixture identity or scenario key.";
    default:
      return "Database seed failed. Verify PostgreSQL is reachable and migrations 0000-0007 are applied.";
  }
}

/**
 * Upserts the complete deterministic Part 20 scenario in one transaction.
 *
 * A transaction handle is accepted as well as the root database handle so a
 * live integration test can wrap repeated calls in an outer rollback-only
 * transaction. Drizzle implements those calls as savepoints, while every seed
 * invocation still has one atomic write boundary.
 */
export async function seedDatabase(db: SeedDatabaseClient): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const migrationProbe = await tx.execute(sql`
      select (
        to_regclass('public.users') is not null
        and to_regclass('public.workspaces') is not null
        and to_regclass('public.notes') is not null
        and to_regclass('public.attachments') is not null
        and to_regclass('public.tasks') is not null
        and to_regclass('public.job_idempotency') is not null
        and to_regclass('public.job_outbox') is not null
      ) as ready
    `);
    if (!isMigrationProbeRow(migrationProbe.rows[0])) {
      throw new SeedSetupError(
        "Database migrations 0000-0007 must be applied before running the seed.",
      );
    }

    const createdAt = fixedDate(SEED_TIMESTAMPS.created);
    const updatedAt = fixedDate(SEED_TIMESTAMPS.updated);

    const userRows = Object.values(SEED_IDENTITIES).map((identity) => ({
      id: identity.id,
      email: identity.email,
      name: identity.label,
      image: null,
      emailVerified: false,
      emailVerifiedAt: null,
      twoFactorEnabled: false,
      createdAt,
      updatedAt,
    })) satisfies Array<typeof users.$inferInsert>;
    for (const row of userRows) {
      await tx
        .insert(users)
        .values(row)
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email: row.email,
            name: row.name,
            image: row.image,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        });
    }

    const workspaceRows = [
      {
        id: SEED_IDS.workspaces.alpha,
        name: SEED_SCENARIOS.alpha.workspaceName,
        slug: SEED_SCENARIOS.alpha.workspaceSlug,
        description: "A deterministic collaborative product-planning scenario.",
        plan: "pro",
        settings: { accentColor: "#2563eb", defaultPageSize: "a4", scenario: "alpha" },
        storageLimitBytes: 1_073_741_824,
        createdById: SEED_IDS.users.alphaOwner,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.workspaces.beta,
        name: SEED_SCENARIOS.beta.workspaceName,
        slug: SEED_SCENARIOS.beta.workspaceSlug,
        description: "A separate deterministic research scenario for isolation checks.",
        plan: "free",
        settings: { accentColor: "#0f766e", defaultPageSize: "letter", scenario: "beta" },
        storageLimitBytes: 536_870_912,
        createdById: SEED_IDS.users.betaOwner,
        createdAt,
        updatedAt,
      },
    ] satisfies Array<typeof workspaces.$inferInsert>;
    for (const row of workspaceRows) {
      await tx
        .insert(workspaces)
        .values(row)
        .onConflictDoUpdate({ target: workspaces.id, set: withoutId(row) });
    }

    const membershipRows = [
      {
        id: SEED_IDS.memberships.alphaOwner,
        workspaceId: SEED_IDS.workspaces.alpha,
        userId: SEED_IDS.users.alphaOwner,
        role: "owner",
        joinedAt: createdAt,
      },
      {
        id: SEED_IDS.memberships.alphaAdmin,
        workspaceId: SEED_IDS.workspaces.alpha,
        userId: SEED_IDS.users.alphaAdmin,
        role: "admin",
        joinedAt: createdAt,
      },
      {
        id: SEED_IDS.memberships.alphaEditor,
        workspaceId: SEED_IDS.workspaces.alpha,
        userId: SEED_IDS.users.alphaEditor,
        role: "editor",
        joinedAt: createdAt,
      },
      {
        id: SEED_IDS.memberships.alphaViewer,
        workspaceId: SEED_IDS.workspaces.alpha,
        userId: SEED_IDS.users.alphaViewer,
        role: "viewer",
        joinedAt: createdAt,
      },
      {
        id: SEED_IDS.memberships.betaOwner,
        workspaceId: SEED_IDS.workspaces.beta,
        userId: SEED_IDS.users.betaOwner,
        role: "owner",
        joinedAt: createdAt,
      },
      {
        id: SEED_IDS.memberships.betaEditor,
        workspaceId: SEED_IDS.workspaces.beta,
        userId: SEED_IDS.users.betaEditor,
        role: "editor",
        joinedAt: createdAt,
      },
    ] satisfies Array<typeof workspaceMembers.$inferInsert>;
    for (const row of membershipRows) {
      await tx
        .insert(workspaceMembers)
        .values(row)
        .onConflictDoUpdate({ target: workspaceMembers.id, set: withoutId(row) });
    }

    const projectRows = [
      {
        id: SEED_IDS.projects.alphaLaunch,
        workspaceId: SEED_IDS.workspaces.alpha,
        name: "Spring Launch",
        description: "Product launch decisions, briefs, and milestones.",
        color: "#2563eb",
        status: "active",
        dueDate: fixedDate(SEED_TIMESTAMPS.dueLater),
        isArchived: false,
        createdById: SEED_IDS.users.alphaOwner,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.projects.alphaOperations,
        workspaceId: SEED_IDS.workspaces.alpha,
        name: "Team Operations",
        description: "Recurring operating tasks and team playbooks.",
        color: "#7c3aed",
        status: "active",
        dueDate: null,
        isArchived: false,
        createdById: SEED_IDS.users.alphaAdmin,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.projects.betaResearch,
        workspaceId: SEED_IDS.workspaces.beta,
        name: "Research Notebook",
        description: "An isolated Beta workspace project.",
        color: "#0f766e",
        status: "active",
        dueDate: fixedDate(SEED_TIMESTAMPS.dueLater),
        isArchived: false,
        createdById: SEED_IDS.users.betaOwner,
        createdAt,
        updatedAt,
      },
    ] satisfies Array<typeof projects.$inferInsert>;
    for (const row of projectRows) {
      await tx
        .insert(projects)
        .values(row)
        .onConflictDoUpdate({ target: projects.id, set: withoutId(row) });
    }

    const rootFolderRows = [
      {
        id: SEED_IDS.folders.alphaHandbook,
        workspaceId: SEED_IDS.workspaces.alpha,
        parentId: null,
        name: "Team Handbook",
        createdById: SEED_IDS.users.alphaOwner,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.folders.betaLibrary,
        workspaceId: SEED_IDS.workspaces.beta,
        parentId: null,
        name: "Research Library",
        createdById: SEED_IDS.users.betaOwner,
        createdAt,
        updatedAt,
      },
    ] satisfies Array<typeof folders.$inferInsert>;
    for (const row of rootFolderRows) {
      await tx
        .insert(folders)
        .values(row)
        .onConflictDoUpdate({ target: folders.id, set: withoutId(row) });
    }
    const nestedFolderRow = {
      id: SEED_IDS.folders.alphaPlaybooks,
      workspaceId: SEED_IDS.workspaces.alpha,
      parentId: SEED_IDS.folders.alphaHandbook,
      name: "Playbooks",
      createdById: SEED_IDS.users.alphaAdmin,
      createdAt,
      updatedAt,
    } satisfies typeof folders.$inferInsert;
    await tx
      .insert(folders)
      .values(nestedFolderRow)
      .onConflictDoUpdate({ target: folders.id, set: withoutId(nestedFolderRow) });

    const rootNoteRows = [
      {
        id: SEED_IDS.notes.alphaPinnedRoot,
        workspaceId: SEED_IDS.workspaces.alpha,
        projectId: null,
        folderId: null,
        parentId: null,
        title: "Alpha workspace home",
        content: simpleDocument("A pinned standalone starting point for the Alpha team."),
        contentPlain: "A pinned standalone starting point for the Alpha team.",
        noteType: "document",
        isTemplate: false,
        isPinned: true,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 1,
        pageSize: "a4",
        sortOrder: 1,
        createdById: SEED_IDS.users.alphaOwner,
        updatedById: SEED_IDS.users.alphaEditor,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.alphaProjectOverview,
        workspaceId: SEED_IDS.workspaces.alpha,
        projectId: SEED_IDS.projects.alphaLaunch,
        folderId: null,
        parentId: null,
        title: "Launch overview",
        content: RICH_TIPTAP_DOCUMENT,
        contentPlain: RICH_CONTENT_PLAIN,
        // Literal like `contentPlain`, and for the same reason: the seed states
        // the projection instead of deriving it, so a fixture that drifts from
        // its document is a visible diff rather than a silent one.
        checklistDone: 1,
        checklistTotal: 2,
        noteType: "document",
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 3,
        pageSize: "a4",
        sortOrder: 1,
        createdById: SEED_IDS.users.alphaOwner,
        updatedById: SEED_IDS.users.alphaEditor,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.alphaFolderNote,
        workspaceId: SEED_IDS.workspaces.alpha,
        projectId: null,
        folderId: SEED_IDS.folders.alphaPlaybooks,
        parentId: null,
        title: "Incident review playbook",
        content: simpleDocument("Capture context, impact, decisions, owners, and follow-up dates."),
        contentPlain: "Capture context, impact, decisions, owners, and follow-up dates.",
        noteType: "document",
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 1,
        pageSize: "letter",
        sortOrder: 2,
        createdById: SEED_IDS.users.alphaAdmin,
        updatedById: SEED_IDS.users.alphaAdmin,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.alphaTemplate,
        workspaceId: SEED_IDS.workspaces.alpha,
        projectId: null,
        folderId: null,
        parentId: null,
        title: "Weekly update template",
        content: simpleDocument("Wins\nRisks\nNext steps"),
        contentPlain: "Wins\nRisks\nNext steps",
        noteType: "document",
        isTemplate: true,
        isPinned: false,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 1,
        pageSize: "a4",
        sortOrder: 3,
        createdById: SEED_IDS.users.alphaEditor,
        updatedById: SEED_IDS.users.alphaEditor,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.alphaDeleted,
        workspaceId: SEED_IDS.workspaces.alpha,
        projectId: null,
        folderId: null,
        parentId: null,
        title: "Retired launch draft",
        content: simpleDocument("A soft-deleted draft retained for trash and restore scenarios."),
        contentPlain: "A soft-deleted draft retained for trash and restore scenarios.",
        noteType: "document",
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        isDeleted: true,
        deletedAt: fixedDate(SEED_TIMESTAMPS.deleted),
        version: 2,
        pageSize: "a4",
        sortOrder: 4,
        createdById: SEED_IDS.users.alphaEditor,
        updatedById: SEED_IDS.users.alphaAdmin,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.alphaTaskNote,
        workspaceId: SEED_IDS.workspaces.alpha,
        projectId: SEED_IDS.projects.alphaOperations,
        folderId: null,
        parentId: null,
        title: "Launch task list",
        content: TASK_TIPTAP_DOCUMENT,
        contentPlain: TASK_CONTENT_PLAIN,
        checklistDone: 0,
        checklistTotal: 1,
        noteType: "task",
        isTemplate: false,
        isPinned: true,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 1,
        pageSize: "a4",
        sortOrder: 2,
        createdById: SEED_IDS.users.alphaAdmin,
        updatedById: SEED_IDS.users.alphaEditor,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.betaRoot,
        workspaceId: SEED_IDS.workspaces.beta,
        projectId: null,
        folderId: SEED_IDS.folders.betaLibrary,
        parentId: null,
        title: "Beta research index",
        content: simpleDocument("This note belongs only to the Beta isolation tenant."),
        contentPlain: "This note belongs only to the Beta isolation tenant.",
        noteType: "document",
        isTemplate: false,
        isPinned: true,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 1,
        pageSize: "letter",
        sortOrder: 1,
        createdById: SEED_IDS.users.betaOwner,
        updatedById: SEED_IDS.users.betaEditor,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.notes.betaProjectNote,
        workspaceId: SEED_IDS.workspaces.beta,
        projectId: SEED_IDS.projects.betaResearch,
        folderId: null,
        parentId: null,
        title: "Research observations",
        content: simpleDocument("Beta project findings remain separate from Alpha content."),
        contentPlain: "Beta project findings remain separate from Alpha content.",
        noteType: "document",
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        version: 1,
        pageSize: "letter",
        sortOrder: 1,
        createdById: SEED_IDS.users.betaEditor,
        updatedById: SEED_IDS.users.betaEditor,
        createdAt,
        updatedAt,
      },
    ] satisfies Array<typeof notes.$inferInsert>;
    for (const row of rootNoteRows) {
      await tx
        .insert(notes)
        .values(row)
        .onConflictDoUpdate({ target: notes.id, set: withoutId(row) });
    }

    const childNoteRow = {
      id: SEED_IDS.notes.alphaProjectChild,
      workspaceId: SEED_IDS.workspaces.alpha,
      projectId: SEED_IDS.projects.alphaLaunch,
      folderId: null,
      parentId: SEED_IDS.notes.alphaProjectOverview,
      title: "Launch decisions",
      content: simpleDocument("The team selected a staged release and documented owners."),
      contentPlain: "The team selected a staged release and documented owners.",
      noteType: "document",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      isDeleted: false,
      deletedAt: null,
      version: 1,
      pageSize: "a4",
      sortOrder: 1,
      createdById: SEED_IDS.users.alphaEditor,
      updatedById: SEED_IDS.users.alphaEditor,
      createdAt,
      updatedAt,
    } satisfies typeof notes.$inferInsert;
    await tx
      .insert(notes)
      .values(childNoteRow)
      .onConflictDoUpdate({ target: notes.id, set: withoutId(childNoteRow) });

    const tagRows = [
      {
        id: SEED_IDS.tags.alphaPlanning,
        workspaceId: SEED_IDS.workspaces.alpha,
        name: "planning",
        color: "#2563eb",
        createdAt,
      },
      {
        id: SEED_IDS.tags.alphaUrgent,
        workspaceId: SEED_IDS.workspaces.alpha,
        name: "urgent",
        color: "#dc2626",
        createdAt,
      },
      {
        id: SEED_IDS.tags.betaResearch,
        workspaceId: SEED_IDS.workspaces.beta,
        name: "research",
        color: "#0f766e",
        createdAt,
      },
    ] satisfies Array<typeof tags.$inferInsert>;
    for (const row of tagRows) {
      await tx
        .insert(tags)
        .values(row)
        .onConflictDoUpdate({ target: tags.id, set: withoutId(row) });
    }

    const noteTagRows = [
      { noteId: SEED_IDS.notes.alphaPinnedRoot, tagId: SEED_IDS.tags.alphaPlanning },
      { noteId: SEED_IDS.notes.alphaProjectOverview, tagId: SEED_IDS.tags.alphaPlanning },
      { noteId: SEED_IDS.notes.alphaProjectOverview, tagId: SEED_IDS.tags.alphaUrgent },
      { noteId: SEED_IDS.notes.betaRoot, tagId: SEED_IDS.tags.betaResearch },
    ] satisfies Array<typeof noteTags.$inferInsert>;
    await tx
      .insert(noteTags)
      .values(noteTagRows)
      .onConflictDoNothing({ target: [noteTags.noteId, noteTags.tagId] });

    const parentCommentRow = {
      id: SEED_IDS.comments.alphaThread,
      noteId: SEED_IDS.notes.alphaProjectOverview,
      parentId: null,
      content: "Can we make the launch outcome measurable?",
      createdById: SEED_IDS.users.alphaViewer,
      isResolved: false,
      resolvedAt: null,
      resolvedById: null,
      anchorKey: "launch-overview-goals",
      anchorFrom: 0,
      anchorTo: 17,
      anchorMetadata: {
        schemaVersion: 1,
        nodePath: [2, 0],
        noteVersion: 3,
        affinity: "forward",
      },
      createdAt: fixedDate(SEED_TIMESTAMPS.version3),
      updatedAt,
    } satisfies typeof comments.$inferInsert;
    await tx
      .insert(comments)
      .values(parentCommentRow)
      .onConflictDoUpdate({ target: comments.id, set: withoutId(parentCommentRow) });

    const replyCommentRow = {
      id: SEED_IDS.comments.alphaReply,
      noteId: SEED_IDS.notes.alphaProjectOverview,
      parentId: SEED_IDS.comments.alphaThread,
      content: "Yes, the overview now includes the activation target.",
      createdById: SEED_IDS.users.alphaEditor,
      isResolved: false,
      resolvedAt: null,
      resolvedById: null,
      anchorKey: null,
      anchorFrom: null,
      anchorTo: null,
      anchorMetadata: {},
      createdAt: updatedAt,
      updatedAt,
    } satisfies typeof comments.$inferInsert;
    await tx
      .insert(comments)
      .values(replyCommentRow)
      .onConflictDoUpdate({ target: comments.id, set: withoutId(replyCommentRow) });

    const versionRows = [
      {
        id: SEED_IDS.noteVersions.alphaOverviewV1,
        noteId: SEED_IDS.notes.alphaProjectOverview,
        version: 1,
        title: "Launch outline",
        content: simpleDocument("Initial launch outline."),
        contentPlain: "Initial launch outline.",
        createdById: SEED_IDS.users.alphaOwner,
        createdAt: fixedDate(SEED_TIMESTAMPS.version1),
      },
      {
        id: SEED_IDS.noteVersions.alphaOverviewV2,
        noteId: SEED_IDS.notes.alphaProjectOverview,
        version: 2,
        title: "Launch overview",
        content: simpleDocument("Launch goals, sequence, and decision owners."),
        contentPlain: "Launch goals, sequence, and decision owners.",
        createdById: SEED_IDS.users.alphaAdmin,
        createdAt: fixedDate(SEED_TIMESTAMPS.version2),
      },
      {
        id: SEED_IDS.noteVersions.alphaOverviewV3,
        noteId: SEED_IDS.notes.alphaProjectOverview,
        version: 3,
        title: "Launch overview",
        content: RICH_TIPTAP_DOCUMENT,
        contentPlain: RICH_CONTENT_PLAIN,
        createdById: SEED_IDS.users.alphaEditor,
        createdAt: fixedDate(SEED_TIMESTAMPS.version3),
      },
    ] satisfies Array<typeof noteVersions.$inferInsert>;
    for (const row of versionRows) {
      await tx
        .insert(noteVersions)
        .values(row)
        .onConflictDoUpdate({ target: noteVersions.id, set: withoutId(row) });
    }

    const attachmentRow = {
      id: SEED_IDS.attachments.alphaBrief,
      noteId: SEED_IDS.notes.alphaProjectOverview,
      workspaceId: SEED_IDS.workspaces.alpha,
      originalName: "launch-brief.pdf",
      filename: "launch-brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 184_320,
      storageKey: "seed/20/8f1d4b7a0c3e4a91b64f2d7801f559d2",
      mediaType: "file",
      processingStatus: "ready",
      processingError: null,
      variants: {
        preview: {
          key: "seed/20/9ae2c1f784d54a3b83fe0d0c174b5b16",
          mimeType: "image/png",
          width: 320,
          height: 452,
        },
      },
      width: null,
      height: null,
      createdById: SEED_IDS.users.alphaEditor,
      createdAt: updatedAt,
    } satisfies typeof attachments.$inferInsert;
    await tx
      .insert(attachments)
      .values(attachmentRow)
      .onConflictDoUpdate({ target: attachments.id, set: withoutId(attachmentRow) });

    const taskStatusRow = {
      id: SEED_IDS.taskStatuses.alphaReview,
      workspaceId: SEED_IDS.workspaces.alpha,
      projectId: SEED_IDS.projects.alphaOperations,
      name: "Needs review",
      color: "#d97706",
      sortOrder: 2,
      isBuiltIn: false,
      createdAt,
      updatedAt,
    } satisfies typeof taskStatuses.$inferInsert;
    await tx
      .insert(taskStatuses)
      .values(taskStatusRow)
      .onConflictDoUpdate({ target: taskStatuses.id, set: withoutId(taskStatusRow) });

    const rootTaskRows = [
      {
        id: SEED_IDS.tasks.alphaPrepareLaunch,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: SEED_IDS.notes.alphaTaskNote,
        projectId: SEED_IDS.projects.alphaOperations,
        title: "Prepare launch assets",
        description: "Coordinate the approved launch copy and supporting assets.",
        status: "in_progress",
        customStatusId: null,
        priority: "high",
        assigneeId: SEED_IDS.users.alphaEditor,
        dueDate: fixedDate(SEED_TIMESTAMPS.dueSoon),
        completedAt: null,
        parentId: null,
        sortOrder: 1,
        recurrence: "weekly",
        recurrenceCron: null,
        createdById: SEED_IDS.users.alphaAdmin,
        updatedById: SEED_IDS.users.alphaEditor,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.tasks.alphaPublishNotes,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: SEED_IDS.notes.alphaTaskNote,
        projectId: SEED_IDS.projects.alphaOperations,
        title: "Publish decision notes",
        description: "Make the approved decision record available to viewers.",
        status: "done",
        customStatusId: null,
        priority: "medium",
        assigneeId: SEED_IDS.users.alphaAdmin,
        dueDate: fixedDate(SEED_TIMESTAMPS.dueSoon),
        completedAt: fixedDate(SEED_TIMESTAMPS.completed),
        parentId: null,
        sortOrder: 2,
        recurrence: "none",
        recurrenceCron: null,
        createdById: SEED_IDS.users.alphaOwner,
        updatedById: SEED_IDS.users.alphaAdmin,
        createdAt,
        updatedAt,
      },
      {
        id: SEED_IDS.tasks.alphaStandaloneFollowUp,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: null,
        projectId: null,
        title: "Review launch metrics",
        description: "A standalone recurring workspace task, independent of a note.",
        status: "todo",
        customStatusId: null,
        priority: "medium",
        assigneeId: SEED_IDS.users.alphaOwner,
        dueDate: fixedDate(SEED_TIMESTAMPS.dueLater),
        completedAt: null,
        parentId: null,
        sortOrder: 3,
        recurrence: "custom",
        recurrenceCron: "0 9 * * 1",
        createdById: SEED_IDS.users.alphaOwner,
        updatedById: SEED_IDS.users.alphaOwner,
        createdAt,
        updatedAt,
      },
    ] satisfies Array<typeof tasks.$inferInsert>;
    for (const row of rootTaskRows) {
      await tx
        .insert(tasks)
        .values(row)
        .onConflictDoUpdate({ target: tasks.id, set: withoutId(row) });
    }

    const childTaskRow = {
      id: SEED_IDS.tasks.alphaConfirmCopy,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: SEED_IDS.notes.alphaTaskNote,
      projectId: SEED_IDS.projects.alphaOperations,
      title: "Confirm final launch copy",
      description: "Nested review item using the custom board status.",
      status: "todo",
      customStatusId: SEED_IDS.taskStatuses.alphaReview,
      priority: "urgent",
      assigneeId: SEED_IDS.users.alphaAdmin,
      dueDate: fixedDate(SEED_TIMESTAMPS.dueSoon),
      completedAt: null,
      parentId: SEED_IDS.tasks.alphaPrepareLaunch,
      sortOrder: 1,
      recurrence: "none",
      recurrenceCron: null,
      createdById: SEED_IDS.users.alphaEditor,
      updatedById: SEED_IDS.users.alphaEditor,
      createdAt,
      updatedAt,
    } satisfies typeof tasks.$inferInsert;
    await tx
      .insert(tasks)
      .values(childTaskRow)
      .onConflictDoUpdate({ target: tasks.id, set: withoutId(childTaskRow) });

    const taskTagRows = [
      { taskId: SEED_IDS.tasks.alphaPrepareLaunch, tagId: SEED_IDS.tags.alphaUrgent },
      { taskId: SEED_IDS.tasks.alphaStandaloneFollowUp, tagId: SEED_IDS.tags.alphaPlanning },
    ] satisfies Array<typeof taskTags.$inferInsert>;
    await tx
      .insert(taskTags)
      .values(taskTagRows)
      .onConflictDoNothing({ target: [taskTags.taskId, taskTags.tagId] });

    return {
      scenarios: [SEED_SCENARIOS.alpha.label, SEED_SCENARIOS.beta.label],
      counts: SEED_EXPECTED_COUNTS,
    };
  });
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  assertSafeSeedTarget(process.env);
  if (connectionString === undefined || connectionString === "") {
    throw new SeedSetupError("DATABASE_URL is required for database seeding.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const result = await seedDatabase(db);
    process.stdout.write(`Seed scenarios: ${result.scenarios.join(", ")}\n`);
    process.stdout.write(
      `Seed counts: ${Object.entries(result.counts)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}\n`,
    );
  } finally {
    await pool.end();
  }
}

const seedEntrypoint = process.argv[1]?.replaceAll("\\", "/");
if (
  seedEntrypoint === "src/database/seed.ts" ||
  seedEntrypoint?.endsWith("/src/database/seed.ts") === true
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeSeedErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
