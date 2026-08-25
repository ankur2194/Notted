// Part 60 — inline comments and mentions against a live, disposable PostgreSQL.
//
// Same shape as `note-versions.integration.test.ts`: self-provisioning
// (`migrate` + `seedDatabase`), self-skipping when no reachable `DATABASE_URL`
// is configured, and every collaborator constructed BY HAND rather than through
// the Nest container, so the test exercises the real SQL and the real policies
// without booting the application graph.
//
// NO REDIS, NO BULLMQ LOOP. The mention pipeline is proved by reading the
// `job_outbox` rows the producer wrote inside `NotesService.update`'s
// transaction and then invoking `MentionNotificationWorkerService.handle`
// directly with a hand-built `QueueJobContext`. A live queue would add a broker,
// a poll loop, and a source of flakes without touching a single line of the
// behaviour under test — the outbox row IS the contract between the two halves.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { CommentsService } from "../src/comments/comments.service";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  jobOutbox,
  notes,
  notifications,
  projectAccess,
  projects,
  schema,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { WorkspaceEmailProducerService } from "../src/email/workspace-email-producer.service";
import { NoteVersionsService } from "../src/notes/note-versions.service";
import { NotesService } from "../src/notes/notes.service";
import { MentionNotificationProducer } from "../src/notifications/mention-notification.producer";
import { MentionNotificationWorkerService } from "../src/notifications/mention-notification.worker.service";
import { NotificationService } from "../src/notifications/notification.service";
import { DOMAIN_JOB_TYPES } from "../src/queue/job-identifiers";
import { MENTION_NOTIFY_JOB_DEFINITION } from "../src/queue/job-registry";
import { RealtimeRoomService } from "../src/realtime/realtime-room.service";
import { REALTIME_EVENTS } from "../src/realtime/realtime.contracts";
import { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import { TenantContextService } from "../src/tenant";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { QueueHandlerRegistry } from "../src/queue/queue-handler-registry.service";
import type { AuthenticatedPrincipal, NoteDocument } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";
import type { Server } from "socket.io";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `comment:${userId}`,
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** One paragraph per mentioned user; the label is the untrusted display snapshot. */
function mentionDocument(userIds: readonly string[]): NoteDocument {
  return {
    type: "doc",
    content: userIds.map((id) => ({
      type: "paragraph",
      content: [{ type: "mention", attrs: { id, label: `Member ${id.slice(0, 8)}` } }],
    })),
  };
}

function build(db: NodePgDatabase<typeof schema>) {
  const tenant = new TenantContextService();
  const database = {
    db,
    transaction: <T>(
      work: (scope: DatabaseTransaction) => Promise<T>,
      config?: PgTransactionConfig,
    ) => db.transaction(work, config),
  } as unknown as DatabaseService;
  const logger = { info: () => undefined, warn: () => undefined } as unknown as StructuredLogger;
  const authorization = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  // The REAL room service with a fake io server behind it, not an `emit`
  // no-op. A stub proved only that a method was called; this proves the room
  // NAME the frame actually lands in, which is the thing that silently drifts
  // if anyone ever rebuilds the key beside `RealtimeRoomService.room`.
  const realtimeEmit = vi.fn<(room: string, event: string, payload: unknown) => void>();
  const realtimeRooms = new RealtimeRoomService();
  realtimeRooms.attach({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => realtimeEmit(room, event, payload),
    }),
  } as unknown as Server);
  return {
    realtimeEmit,
    realtimeRooms,
    commentsService: new CommentsService(database, authorization, tenant, realtimeRooms),
    notesService: new NotesService(
      database,
      authorization,
      tenant,
      { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
      new NoteVersionsService(tenant),
      undefined,
      undefined,
      new MentionNotificationProducer(tenant, logger, new WorkspaceEmailProducerService(tenant)),
    ),
    worker: new MentionNotificationWorkerService(
      database,
      new NotificationService(database, tenant),
      tenant,
      { register: () => () => undefined } as unknown as QueueHandlerRegistry,
      authorization,
    ),
  };
}

async function createNote(
  notesService: NotesService,
  actor: AuthenticatedPrincipal,
  workspaceId: string,
  title: string,
): Promise<{ id: string; version: number }> {
  const created = await notesService.create({
    principal: actor,
    workspaceId,
    title: `${title} ${randomUUID()}`,
    projectId: null,
    folderId: null,
    parentId: null,
    type: "document",
    pageSize: "a4",
    isTemplate: false,
    isPinned: false,
    isArchived: false,
    tagIds: [],
    content: { type: "doc", content: [] },
    idempotencyKey: `comment-fixture-${randomUUID()}`,
  });
  return { id: created.note.id, version: created.note.version };
}

describe.skipIf(!HAS_DATABASE_URL)("Part 60 comments and mentions (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let databaseReachable = false;

  beforeAll(async () => {
    databaseReachable = await reachable(DATABASE_URL as string);
    if (!databaseReachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.transaction(async (tx) => seedDatabase(tx));
  });

  afterAll(async () => pool?.end());

  it("conceals a foreign-workspace comment id as 404 rather than 403", async ({ skip }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { commentsService, notesService } = build(db);
    const betaOwner = principal(SEED_IDS.users.betaOwner);
    const alphaOwner = principal(SEED_IDS.users.alphaOwner);

    const betaNote = await createNote(
      notesService,
      betaOwner,
      SEED_IDS.workspaces.beta,
      "Beta comment host",
    );
    const foreign = await commentsService.create({
      principal: betaOwner,
      workspaceId: SEED_IDS.workspaces.beta,
      noteId: betaNote.id,
      requestId: null,
      content: "Only workspace beta may see this.",
      parentId: null,
      anchor: null,
      idempotencyKey: randomUUID(),
    });

    // 404, never 403: a foreign comment id must not be probeable for existence.
    const scope = {
      principal: alphaOwner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: betaNote.id,
      requestId: null,
      commentId: foreign.comment.id,
    };
    await expect(commentsService.update({ ...scope, content: "hijacked" })).rejects.toMatchObject({
      decision: { allowed: false, httpStatus: 404 },
    });
    await expect(
      commentsService.setResolution({ ...scope, isResolved: true }),
    ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
    await expect(commentsService.remove(scope)).rejects.toMatchObject({
      decision: { allowed: false, httpStatus: 404 },
    });

    const untouched = await commentsService.list({
      principal: betaOwner,
      workspaceId: SEED_IDS.workspaces.beta,
      noteId: betaNote.id,
      requestId: null,
      page: 1,
      limit: 20,
      status: "all",
    });
    expect(untouched.items).toHaveLength(1);
    expect(untouched.items[0]?.content).toBe("Only workspace beta may see this.");
  });

  it("lets a viewer comment but never resolve", async ({ skip }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { commentsService, notesService } = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const viewer = principal(SEED_IDS.users.alphaViewer);
    const note = await createNote(notesService, owner, SEED_IDS.workspaces.alpha, "Viewer comment");
    const scope = {
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: note.id,
      requestId: null,
    };

    // `comment.create` -> `noteCanComment`: read access is enough.
    const created = await commentsService.create({
      ...scope,
      principal: viewer,
      content: "A viewer may still raise a question.",
      parentId: null,
      anchor: null,
      idempotencyKey: randomUUID(),
    });
    expect(created.comment.createdBy.id).toBe(SEED_IDS.users.alphaViewer);

    // `comment.resolve` -> `noteCanEdit`: read access is not enough.
    await expect(
      commentsService.setResolution({
        ...scope,
        principal: viewer,
        commentId: created.comment.id,
        isResolved: true,
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });

    const after = await commentsService.list({
      ...scope,
      principal: owner,
      page: 1,
      limit: 20,
      status: "all",
    });
    expect(after.items[0]?.isResolved).toBe(false);
    expect(after.items[0]?.resolvedBy).toBeNull();
    expect(after.openCount).toBe(1);
  });

  it("refuses to let a non-creator edit or delete another member's comment", async ({ skip }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { commentsService, notesService } = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const note = await createNote(notesService, owner, SEED_IDS.workspaces.alpha, "Ownership");
    const scope = { workspaceId: SEED_IDS.workspaces.alpha, noteId: note.id, requestId: null };
    const created = await commentsService.create({
      ...scope,
      principal: owner,
      content: "Original wording, authored by the owner.",
      parentId: null,
      anchor: null,
      idempotencyKey: randomUUID(),
    });

    // Both roles are denied for the same reason: `comment.update`/`comment.delete`
    // are creator-only, so an editor's broader note rights buy nothing here.
    await expect(
      commentsService.update({
        ...scope,
        principal: principal(SEED_IDS.users.alphaEditor),
        commentId: created.comment.id,
        content: "editor rewrite",
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });
    await expect(
      commentsService.remove({
        ...scope,
        principal: principal(SEED_IDS.users.alphaEditor),
        commentId: created.comment.id,
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });
    await expect(
      commentsService.update({
        ...scope,
        principal: principal(SEED_IDS.users.alphaViewer),
        commentId: created.comment.id,
        content: "viewer rewrite",
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });
    await expect(
      commentsService.remove({
        ...scope,
        principal: principal(SEED_IDS.users.alphaViewer),
        commentId: created.comment.id,
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });

    const after = await commentsService.list({
      ...scope,
      principal: owner,
      page: 1,
      limit: 20,
      status: "all",
    });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.content).toBe("Original wording, authored by the owner.");
  });

  it("returns one member's reply to every other member of the workspace", async ({ skip }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { commentsService, notesService } = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const editor = principal(SEED_IDS.users.alphaEditor);
    const note = await createNote(notesService, owner, SEED_IDS.workspaces.alpha, "Thread sync");
    const scope = { workspaceId: SEED_IDS.workspaces.alpha, noteId: note.id, requestId: null };

    const root = await commentsService.create({
      ...scope,
      principal: owner,
      content: "Does this paragraph still belong here?",
      parentId: null,
      anchor: null,
      idempotencyKey: randomUUID(),
    });
    const reply = await commentsService.create({
      ...scope,
      principal: owner,
      content: "Replying to my own thread.",
      parentId: root.comment.id,
      anchor: null,
      idempotencyKey: randomUUID(),
    });
    // A reply to a reply is silently re-parented onto the thread root; threads
    // stay two levels deep and the client never explains a rejection.
    const nested = await commentsService.create({
      ...scope,
      principal: owner,
      content: "Replying to the reply.",
      parentId: reply.comment.id,
      anchor: null,
      idempotencyKey: randomUUID(),
    });
    expect(nested.comment.parentId).toBe(root.comment.id);

    // The other member reads the same thread through the same authorized path.
    const seenByEditor = await commentsService.list({
      ...scope,
      principal: editor,
      page: 1,
      limit: 20,
      status: "all",
    });
    expect(seenByEditor.items).toHaveLength(1);
    expect(seenByEditor.items[0]?.id).toBe(root.comment.id);
    expect(seenByEditor.items[0]?.replies.map((item) => item.content)).toEqual([
      "Replying to my own thread.",
      "Replying to the reply.",
    ]);
  });

  it("broadcasts every comment mutation to the note room the room service names", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    // The `realtime:comment:changed` fan-out is what makes a second client's
    // sidebar refetch. Nothing else covers it: the browser journey asserts the
    // OUTCOME (a reply appearing) and cannot distinguish a broadcast from a
    // poll, and the unit tests stub the room service out entirely.
    const { commentsService, notesService, realtimeEmit, realtimeRooms } = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const note = await createNote(notesService, owner, SEED_IDS.workspaces.alpha, "Broadcast");
    const scope = {
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: note.id,
      requestId: null,
    };
    const room = realtimeRooms.room({
      kind: "note",
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: note.id,
    });
    const frames = () =>
      (realtimeEmit.mock.calls as [string, string, { kind: string; commentId: string }][]).map(
        ([target, event, payload]) => ({ target, event, ...payload }),
      );

    const root = await commentsService.create({
      ...scope,
      content: "Root comment that opens the thread.",
      parentId: null,
      anchor: null,
      idempotencyKey: randomUUID(),
    });
    const reply = await commentsService.create({
      ...scope,
      content: "A reply on the same thread.",
      parentId: root.comment.id,
      anchor: null,
      idempotencyKey: randomUUID(),
    });
    await commentsService.setResolution({
      ...scope,
      commentId: root.comment.id,
      isResolved: true,
    });
    await commentsService.remove({ ...scope, commentId: reply.comment.id });

    // Identifiers only, never comment text: a content-carrying frame would
    // bypass `comment.read` for a socket that joined before losing permission.
    expect(frames()).toEqual([
      {
        target: room,
        event: REALTIME_EVENTS.commentChanged,
        noteId: note.id,
        commentId: root.comment.id,
        threadId: root.comment.id,
        kind: "created",
      },
      {
        target: room,
        event: REALTIME_EVENTS.commentChanged,
        noteId: note.id,
        commentId: reply.comment.id,
        // A reply carries its THREAD so a client can refetch one thread rather
        // than the whole sidebar.
        threadId: root.comment.id,
        kind: "created",
      },
      {
        target: room,
        event: REALTIME_EVENTS.commentChanged,
        noteId: note.id,
        commentId: root.comment.id,
        threadId: root.comment.id,
        kind: "resolved",
      },
      {
        target: room,
        event: REALTIME_EVENTS.commentChanged,
        noteId: note.id,
        commentId: reply.comment.id,
        threadId: root.comment.id,
        kind: "deleted",
      },
    ]);
    // The room name is derived, never typed out: an inline rebuild that dropped
    // `workspaceId` would still be a plausible-looking string.
    expect(room).not.toContain(note.id);

    await db.delete(notes).where(eq(notes.id, note.id));
  });

  it("never notifies a mention of someone who cannot read the restricted note", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    // Workspace membership is NOT what `note.read` means. A note inside a
    // restricted project is readable only by members of that project — and by
    // the workspace's own owners and admins, who read everything — so a
    // membership-only re-check would hand an ordinary non-member the note's
    // title, id and existence in a notification the note itself would refuse.
    // `alphaViewer` is that non-member: a workspace member with no grant.
    const { notesService, worker } = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      workspaceId: SEED_IDS.workspaces.alpha,
      name: `Restricted ${projectId.slice(0, 8)}`,
      isRestricted: true,
      createdById: SEED_IDS.users.alphaOwner,
    });
    // `alphaEditor` is inside the project; `alphaViewer` is a workspace member
    // with no grant, which is exactly the disclosure being closed. Deliberately
    // NOT `alphaAdmin`: a workspace admin reads every note by policy
    // (`AuthorizationPolicyService.canReadNote`), so excluding one would be a
    // second, stricter authorization rule invented in the worker.
    await db.insert(projectAccess).values([
      {
        projectId,
        userId: SEED_IDS.users.alphaOwner,
        role: "admin",
        createdById: SEED_IDS.users.alphaOwner,
      },
      {
        projectId,
        userId: SEED_IDS.users.alphaEditor,
        role: "editor",
        createdById: SEED_IDS.users.alphaOwner,
      },
    ]);

    const created = await notesService.create({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      title: `Restricted note ${randomUUID()}`,
      projectId,
      folderId: null,
      parentId: null,
      type: "document",
      pageSize: "a4",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      content: { type: "doc", content: [] },
      idempotencyKey: `restricted-fixture-${randomUUID()}`,
    });
    const noteId = created.note.id;

    await notesService.update({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId,
      expectedVersion: created.note.version,
      content: mentionDocument([SEED_IDS.users.alphaEditor, SEED_IDS.users.alphaViewer]),
    });

    const scheduled = await db
      .select()
      .from(jobOutbox)
      .where(
        and(
          eq(jobOutbox.jobType, DOMAIN_JOB_TYPES.mentionNotify),
          sql`${jobOutbox.payload}->>'noteId' = ${noteId}`,
        ),
      );
    // The PRODUCER is membership-scoped and still schedules both: the recipient
    // filter is the consumer's job, because project access can change between
    // the note's commit and the job's run.
    expect(scheduled).toHaveLength(2);

    for (const intent of scheduled) {
      await worker.handle({
        outboxIntentId: intent.id,
        // The processor always supplies these; the handler reads them to tell a
        // retryable attempt from the final one.
        attempt: 1,
        maximumAttempts: 3,
        jobType: MENTION_NOTIFY_JOB_DEFINITION.jobType,
        idempotencyKey: intent.idempotencyKey,
        payload: MENTION_NOTIFY_JOB_DEFINITION.payloadSchema.parse(intent.payload),
        signal: new AbortController().signal,
      });
    }

    const delivered = await db
      .select()
      .from(notifications)
      .where(eq(notifications.targetId, noteId));
    expect(delivered.map((row) => row.recipientUserId)).toEqual([SEED_IDS.users.alphaEditor]);
    // The title never left the project: no row at all, so no label to leak.
    expect(delivered[0]?.targetLabel).toContain("Restricted note");

    await db.delete(notifications).where(eq(notifications.targetId, noteId));
    await db.delete(notes).where(eq(notes.id, noteId));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  it("notifies each newly mentioned member exactly once and drops forged outsiders", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { notesService, worker } = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const note = await createNote(notesService, owner, SEED_IDS.workspaces.alpha, "Mentions");
    const update = (version: number, mentioned: readonly string[]) =>
      notesService.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: note.id,
        expectedVersion: version,
        content: mentionDocument(mentioned),
      });
    const intents = async () =>
      db!
        .select()
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.jobType, DOMAIN_JOB_TYPES.mentionNotify),
            sql`${jobOutbox.payload}->>'noteId' = ${note.id}`,
          ),
        );

    const first = await update(note.version, [SEED_IDS.users.alphaEditor]);
    expect(await intents()).toHaveLength(1);

    // The same document saved again adds nothing: the producer diffs the
    // previous content and returns before issuing any SQL.
    const second = await update(first.note.version, [SEED_IDS.users.alphaEditor]);
    expect(await intents()).toHaveLength(1);

    // One more recipient => exactly one more intent, not a re-notification of
    // the member who was already mentioned.
    const third = await update(second.note.version, [
      SEED_IDS.users.alphaEditor,
      SEED_IDS.users.alphaAdmin,
    ]);
    expect(await intents()).toHaveLength(2);

    // Anti-forging: `betaEditor` is a real user, but not a member of this
    // workspace. The membership intersection drops the id with no error.
    await update(third.note.version, [
      SEED_IDS.users.alphaEditor,
      SEED_IDS.users.alphaAdmin,
      SEED_IDS.users.betaEditor,
    ]);
    const scheduled = await intents();
    expect(scheduled).toHaveLength(2);
    expect(new Set(scheduled.map((intent) => intent.idempotencyKey)).size).toBe(2);

    // Drive the consumer directly — no Redis, no BullMQ loop (see file header).
    for (const intent of scheduled) {
      await worker.handle({
        outboxIntentId: intent.id,
        // The processor always supplies these; the handler reads them to tell a
        // retryable attempt from the final one.
        attempt: 1,
        maximumAttempts: 3,
        jobType: MENTION_NOTIFY_JOB_DEFINITION.jobType,
        idempotencyKey: intent.idempotencyKey,
        payload: MENTION_NOTIFY_JOB_DEFINITION.payloadSchema.parse(intent.payload),
        signal: new AbortController().signal,
      });
    }

    const delivered = await db
      .select()
      .from(notifications)
      .where(eq(notifications.targetId, note.id));
    expect(delivered).toHaveLength(2);
    expect(delivered.map((row) => row.recipientUserId).sort()).toEqual(
      [SEED_IDS.users.alphaEditor, SEED_IDS.users.alphaAdmin].sort(),
    );
    expect(delivered.every((row) => row.kind === "mention" && row.readAt === null)).toBe(true);
    expect(delivered.every((row) => row.actorUserId === SEED_IDS.users.alphaOwner)).toBe(true);

    await db.delete(notifications).where(eq(notifications.targetId, note.id));
    await db.delete(notes).where(eq(notes.id, note.id));
  });
});
