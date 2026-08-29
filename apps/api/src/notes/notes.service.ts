import { randomUUID } from "node:crypto";

import { HttpStatus, Injectable, Optional } from "@nestjs/common";
import {
  countChecklist,
  extractNoteContentPlain,
  migrateNoteDocument,
  noteVersionCursorSchema,
} from "@notted/shared-validators";
import { and, asc, desc, eq, exists, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  notes,
  noteVersions,
  noteTags,
  projectAccess,
  projects,
  tags,
  tasks,
  taskStatuses,
  workspaceMembers,
  users,
} from "../database/schema";
import { taskDoneCount, taskOpenTotalCount } from "../database/sql-aggregates";
import { MentionNotificationProducer } from "../notifications/mention-notification.producer";
import { NoteCollaborationService } from "../realtime/yjs/note-collaboration.service";
import { NoteEmbeddingProducer } from "../search/note-embedding-producer";
import { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";
import { WebhookDeliveryProducer } from "../webhooks/webhook-delivery.producer";

import { FoldersService } from "./folders.service";
import { recordNoteMutation } from "./note-mutation-record";
import { NoteVersionsService } from "./note-versions.service";
import { NOTE_DEFAULT_DOCUMENT, NOTE_DOMAIN_EVENTS, type NoteMutation } from "./notes.constants";

import type { AuthorizationRunner } from "../authorization/authorization.repository";
import type {
  AuthenticatedPrincipal,
  FolderCreateResult,
  FolderDeleteResult,
  FolderPage,
  FolderUpdateResult,
  NoteCreateResult,
  NoteDeleteResult,
  NoteDetail,
  NoteDocument,
  NoteListView,
  NoteMoveResult,
  NoteNavigation,
  NotePage,
  NotePermanentDeleteResult,
  NoteRestoreResult,
  NoteSortField,
  NoteSummary,
  NoteType,
  NoteUpdateResult,
  NoteVersionDetail,
  NoteVersionPage,
  NoteVersionRestoreResult,
  NoteVersionSummary,
  PageSize,
  Progress,
} from "@notted/shared-types";

/** A note with no task rows attached. Shared so the zero is written once. */
const NO_PROGRESS: Progress = Object.freeze({ done: 0, total: 0 });

export interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface NoteSelector extends ScopedInput {
  readonly noteId: string;
}

interface Container {
  readonly projectId: string | null;
  readonly folderId: string | null;
  readonly parentId: string | null;
}

interface NoteRow extends Container {
  readonly id: string;
  readonly workspaceId: string;
  // Deliberately NOT on `Container`: the board column is an orthogonal axis,
  // not part of the coupled project/folder/parent placement decision.
  readonly boardColumnId: string | null;
  readonly title: string;
  readonly content: unknown;
  readonly contentPlain: string | null;
  readonly checklistDone: number;
  readonly checklistTotal: number;
  readonly noteType: "document" | "task";
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly isDeleted: boolean;
  readonly deletedAt: Date | null;
  readonly deletionBatchId: string | null;
  readonly version: number;
  readonly pageSize: string;
  readonly sortOrder: number;
  readonly createdById: string;
  readonly updatedById: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateNoteServiceInput extends ScopedInput, Container {
  readonly title: string;
  readonly type: NoteType;
  readonly pageSize: PageSize;
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly tagIds: readonly string[];
  readonly content?: NoteDocument;
  readonly idempotencyKey: string;
}

export interface ListNotesServiceInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly scope: "workspace-root" | "project";
  readonly projectId?: string;
  readonly folderId?: string;
  readonly rootFolder?: boolean;
  readonly parentId?: string;
  readonly rootParent?: boolean;
  readonly type?: NoteType;
  readonly view: NoteListView;
  readonly isTemplate?: boolean;
  readonly isPinned?: boolean;
  readonly isArchived?: boolean;
  readonly tagId?: string;
  readonly sortBy: NoteSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface UpdateNoteServiceInput extends NoteSelector {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly type?: NoteType;
  readonly pageSize?: PageSize;
  readonly isTemplate?: boolean;
  readonly isPinned?: boolean;
  readonly isArchived?: boolean;
  readonly tagIds?: readonly string[];
  readonly content?: NoteDocument;
}

export interface ListNoteVersionsServiceInput extends NoteSelector {
  readonly limit: number;
  readonly cursor?: string;
}

export interface NoteVersionSelector extends NoteSelector {
  readonly versionId: string;
}

export interface RestoreNoteVersionServiceInput extends NoteVersionSelector {
  readonly expectedVersion: number;
}

interface NoteVersionCursor {
  readonly createdAt: string;
  readonly id: string;
}

type VersionDatabase = Pick<DatabaseTransaction, "select">;

function encodeVersionCursor(cursor: NoteVersionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeVersionCursor(value: string): NoteVersionCursor | null {
  if (!noteVersionCursorSchema.safeParse(value).success) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string") return null;
    const date = new Date(candidate.createdAt);
    if (!Number.isFinite(date.getTime())) return null;
    return { createdAt: date.toISOString(), id: candidate.id };
  } catch {
    return null;
  }
}

export interface MoveNoteServiceInput extends NoteSelector, Container {
  readonly expectedVersion: number;
  /** Omitted keeps the current column; `null` is an explicit "No column". */
  readonly boardColumnId?: string | null;
  readonly beforeNoteId?: string | null;
}

export interface CopyNoteServiceInput extends NoteSelector, Container {
  readonly asTemplate: boolean;
  readonly includeTags: boolean;
  readonly title?: string;
  readonly idempotencyKey: string;
}

export interface VersionedNoteServiceInput extends NoteSelector {
  readonly expectedVersion: number;
}

export interface PermanentDeleteNoteServiceInput extends VersionedNoteServiceInput {
  readonly expectedTitle: string;
}

export interface NavigationServiceInput extends ScopedInput {
  readonly limit: number;
  readonly includeArchived: boolean;
  readonly projectId?: string;
}

export interface ListFoldersServiceInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly parentId?: string;
  readonly root?: boolean;
}

export interface CreateFolderServiceInput extends ScopedInput {
  readonly name: string;
  readonly parentId?: string | null;
}

export interface UpdateFolderServiceInput extends ScopedInput {
  readonly folderId: string;
  readonly name?: string;
  readonly parentId?: string | null;
}

export interface DeleteFolderServiceInput extends ScopedInput {
  readonly folderId: string;
}

@Injectable()
export class NotesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    // Part 51.3 — emits `note.search.sync` intents inside the same
    // transaction as each note mutation so the Meilisearch handler can
    // re-read authoritative PostgreSQL and converge the index.
    private readonly searchIndexProducer: NoteSearchIndexProducer,
    // Part 55 — writes one immutable `note_versions` snapshot of the accepted
    // post-save state inside create/copy/update transactions. Required: a
    // missing provider must fail loudly rather than silently disabling history.
    private readonly noteVersions: NoteVersionsService,
    @Optional() private readonly embeddingProducer?: NoteEmbeddingProducer,
    // Part 58 — reconciles the persisted Yjs authority with a restored
    // projection inside `restoreVersion`'s transaction. Optional so the unit
    // tests can construct this service without the realtime module graph; the
    // application always provides it via `NotesModule`'s `RealtimeModule` import.
    @Optional() private readonly collaboration?: NoteCollaborationService,
    // Part 60 — emits one `notification.mention` intent per newly mentioned
    // workspace member inside `update`'s transaction. Optional for the same
    // reason as the two above: the unit tests construct this service without
    // the notification module graph.
    @Optional() private readonly mentionProducer?: MentionNotificationProducer,
    // Part 66 — emits one `webhook.deliver` intent per subscribed endpoint
    // inside every note-mutation transaction. Optional for the same reason as
    // the three above: the unit tests construct this service without the
    // webhook module graph. `NotesModule` always provides it in the running
    // application, and the producer itself filters the events nobody can
    // subscribe to, so this stays one unconditional call.
    @Optional() private readonly webhookProducer?: WebhookDeliveryProducer,
    // Part 15/16 — the folder use cases, split into their own service. APPENDED,
    // never inserted: eighteen unit-test constructions pass five or six
    // positional arguments, and inserting this earlier would silently shift
    // three existing dependencies in every one of them. `@Optional()` for the
    // same reason — none of those tests exercises a folder path.
    @Optional() private readonly foldersService?: FoldersService,
  ) {}

  async create(input: CreateNoteServiceInput): Promise<NoteCreateResult> {
    const operation = await this.authorizeCreateDestination(input, input);
    return this.authorizationEntry.run(operation, async () => {
      const noteId = randomUUID();
      const content: NoteDocument = input.content ?? NOTE_DEFAULT_DOCUMENT;
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `note.create:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: {
          title: input.title,
          projectId: input.projectId,
          folderId: input.folderId,
          parentId: input.parentId,
          type: input.type,
          pageSize: input.pageSize,
          isTemplate: input.isTemplate,
          isPinned: input.isPinned,
          isArchived: input.isArchived,
          tagIds: input.tagIds,
          content,
        },
      });
      const row = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            assertIdempotencyPayload(replay, idempotency);
            return this.readIdempotentNote(tx, replay.resourceId);
          }
          await this.validateContainer(tx, input, null);
          await this.assertTags(tx, input.tagIds);
          await this.lockSiblingGroups(tx, [input]);
          // Parent placement is rechecked after the sibling-group lock so a
          // concurrent parent move cannot leave the new child behind.
          if (input.parentId !== null) await this.validateContainer(tx, input, null);
          const sortOrder = await this.positionFor(tx, input, null, null);
          const projection = this.contentProjection(content);
          await tx.insert(notes).values(
            assertWorkspaceInsertValues(
              {
                id: noteId,
                workspaceId: activeWorkspaceId(this.tenantContext),
                projectId: input.projectId,
                folderId: input.folderId,
                parentId: input.parentId,
                title: input.title,
                content,
                ...projection,
                noteType: this.toDatabaseType(input.type),
                isTemplate: input.isTemplate,
                isPinned: input.isPinned,
                isArchived: input.isArchived,
                pageSize: input.pageSize,
                sortOrder,
                createdById: input.principal.userId,
                updatedById: input.principal.userId,
              },
              this.tenantContext,
              "note.create",
            ),
          );
          await this.replaceTags(tx, noteId, input.tagIds);
          // Part 55: initial checkpoint. The new note's accepted state is its
          // version-1 state; record one immutable snapshot in the same
          // transaction so a create always has a restorable baseline. The
          // snapshot captures the POST-SAVE state (decision 1).
          await this.noteVersions.recordAcceptedState(tx, {
            noteId,
            workspaceId: activeWorkspaceId(this.tenantContext),
            version: 1,
            title: input.title,
            content,
            contentPlain: projection.contentPlain,
            createdById: input.principal.userId,
          });
          await this.recordMutation(tx, "create", noteId, input);
          // Part 51.3: schedule search-index sync for the newly created note
          // in the same transaction. The handler re-reads authoritative state
          // so an out-of-order delivery still converges to "indexed".
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [noteId], {
            mutation: NOTE_DOMAIN_EVENTS.create,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          await this.embeddingProducer?.scheduleGeneration(tx, input.workspaceId, [noteId], {
            mutation: NOTE_DOMAIN_EVENTS.create,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          await storeApiIdempotency(tx, idempotency, noteId);
          return this.readRow(tx, noteId);
        },
        { isolationLevel: "read committed" },
      );
      return Object.freeze({ note: await this.toDetail(row, { ...input, noteId: row.id }) });
    });
  }

  async list(input: ListNotesServiceInput): Promise<NotePage> {
    const operation =
      input.scope === "project" && input.projectId !== undefined
        ? await this.authorizationEntry.authorizeUser({
            principal: input.principal,
            workspaceId: input.workspaceId,
            action: "project.read",
            resource: { kind: "project", id: input.projectId },
            requestId: input.requestId,
          })
        : await this.authorizeWorkspaceRead(input);
    return this.authorizationEntry.run(operation, async () => {
      const conditions = await this.listConditions(input);
      const sortColumn =
        input.sortBy === "title"
          ? notes.title
          : input.sortBy === "createdAt"
            ? notes.createdAt
            : input.sortBy === "deletedAt"
              ? notes.deletedAt
              : input.sortBy === "sortOrder"
                ? notes.sortOrder
                : notes.updatedAt;
      const direction = input.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const effectiveOrder =
        input.view === "trash"
          ? desc(notes.deletedAt)
          : input.view === "recent" ||
              input.view === "pinned" ||
              input.view === "templates" ||
              input.isArchived === true
            ? desc(notes.updatedAt)
            : direction;
      const rows = await this.database.db
        .select(this.noteSelection())
        .from(notes)
        .where(and(...conditions))
        .orderBy(effectiveOrder, asc(notes.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      const visible = rows.slice(0, input.limit);
      const visibleIds = visible.map((row) => row.id);
      // Two batched lookups for the whole page, never one per row.
      const [tagsByNote, taskProgressByNote] = await Promise.all([
        this.loadTagMap(this.database.db, visibleIds),
        this.loadTaskProgressMap(this.database.db, visibleIds),
      ]);
      return Object.freeze({
        items: Object.freeze(
          visible.map((row) =>
            this.toSummary(
              row,
              tagsByNote.get(row.id) ?? [],
              taskProgressByNote.get(row.id) ?? NO_PROGRESS,
            ),
          ),
        ),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async read(input: NoteSelector): Promise<NoteDetail> {
    const operation = await this.authorizeNote(input, "note.read");
    return this.authorizationEntry.run(operation, async () =>
      this.toDetail(await this.readDatabaseRow(input.noteId), input),
    );
  }

  async listVersions(input: ListNoteVersionsServiceInput): Promise<NoteVersionPage> {
    const operation = await this.authorizeNote(input, "note.read");
    return this.authorizationEntry.run(operation, async () => {
      const cursor = input.cursor === undefined ? null : decodeVersionCursor(input.cursor);
      if (input.cursor !== undefined && cursor === null) this.invalidVersionRequest();
      const cursorDate = cursor === null ? null : new Date(cursor.createdAt);
      const rows = await this.database.db
        .select({
          id: noteVersions.id,
          version: noteVersions.version,
          title: noteVersions.title,
          createdAt: noteVersions.createdAt,
          authorId: users.id,
          authorName: users.name,
          currentVersion: notes.version,
          latestCheckpointVersion: sql<number>`(
            select max(latest_version.version)
            from note_versions latest_version
            where latest_version.note_id = ${noteVersions.noteId}
          )`,
        })
        .from(noteVersions)
        .innerJoin(
          notes,
          and(eq(notes.id, noteVersions.noteId), eq(notes.workspaceId, input.workspaceId)),
        )
        .innerJoin(users, eq(users.id, noteVersions.createdById))
        .where(
          and(
            eq(noteVersions.noteId, input.noteId),
            eq(notes.isDeleted, false),
            cursorDate === null || cursor === null
              ? undefined
              : or(
                  lt(noteVersions.createdAt, cursorDate),
                  and(eq(noteVersions.createdAt, cursorDate), lt(noteVersions.id, cursor.id)),
                ),
          ),
        )
        .orderBy(desc(noteVersions.createdAt), desc(noteVersions.id))
        .limit(input.limit + 1);
      if (rows.length === 0 && cursor === null) await this.readDatabaseRow(input.noteId);
      const visible = rows.slice(0, input.limit);
      const items = visible.map((row) => this.toVersionSummary(row));
      const last = visible.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        hasMore: rows.length > input.limit,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeVersionCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      });
    });
  }

  async readVersion(input: NoteVersionSelector): Promise<NoteVersionDetail> {
    const operation = await this.authorizeNote(input, "note.read");
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.readVersionRow(this.database.db, input);
      const document = this.migrateHistoricalContent(row.content);
      return Object.freeze({ ...this.toVersionSummary(row), content: document });
    });
  }

  async restoreVersion(input: RestoreNoteVersionServiceInput): Promise<NoteVersionRestoreResult> {
    const operation = await this.authorizeNote(input, "note.update");
    return this.authorizationEntry.run(operation, async () => {
      const restored = await this.database.transaction(
        async (tx) => {
          const [current] = await tx
            .select(this.noteSelection())
            .from(notes)
            .where(
              and(
                eq(notes.id, input.noteId),
                eq(notes.workspaceId, input.workspaceId),
                eq(notes.isDeleted, false),
              ),
            )
            .for("update")
            .limit(1);
          if (current === undefined) this.notFound();
          this.assertVersion(current, input.expectedVersion);
          const source = await this.readVersionRow(tx, input);
          if (source.version === source.latestCheckpointVersion) this.currentVersionConflict();
          const content = this.migrateHistoricalContent(source.content);
          const projection = this.contentProjection(content);
          const [updated] = await tx
            .update(notes)
            .set({
              title: source.title,
              content,
              ...projection,
              updatedById: input.principal.userId,
              updatedAt: new Date(),
              version: sql`${notes.version} + 1`,
            })
            .where(
              and(
                eq(notes.id, input.noteId),
                eq(notes.version, input.expectedVersion),
                whereWorkspace(notes, this.tenantContext),
              ),
            )
            .returning(this.noteSelection());
          if (updated === undefined) return this.versionConflictOrNotFound(tx, input.noteId);
          await this.noteVersions.recordAcceptedState(tx, {
            noteId: input.noteId,
            workspaceId: input.workspaceId,
            version: updated.version,
            title: updated.title,
            content: updated.content,
            contentPlain: updated.contentPlain ?? "",
            createdById: input.principal.userId,
          });
          // Part 58: the restored TipTap projection becomes the new Yjs
          // authority in this same transaction — one write authority, not two.
          await this.collaboration?.resetToDocument(tx, {
            noteId: input.noteId,
            workspaceId: input.workspaceId,
            document: updated.content,
            noteVersion: updated.version,
            actorId: input.principal.userId,
          });
          await this.recordMutation(tx, "update", input.noteId, input);
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [input.noteId], {
            mutation: NOTE_DOMAIN_EVENTS.update,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          await this.embeddingProducer?.scheduleGeneration(tx, input.workspaceId, [input.noteId], {
            mutation: NOTE_DOMAIN_EVENTS.update,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          return { updated, source };
        },
        { isolationLevel: "serializable" },
      );
      const note = await this.toDetail(restored.updated, input);
      const createdVersion = await this.versionSummaryForVersion(
        input.workspaceId,
        input.noteId,
        restored.updated.version,
      );
      return Object.freeze({
        note,
        restoredFrom: this.toVersionSummary(restored.source),
        createdVersion,
      });
    });
  }

  async update(input: UpdateNoteServiceInput): Promise<NoteUpdateResult> {
    const operation = await this.authorizeNote(input, "note.update");
    if (input.tagIds !== undefined) await this.authorizeNote(input, "note.tag");
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(
        async (tx) => {
          if (input.tagIds !== undefined) await this.assertTags(tx, input.tagIds);
          const current = await this.readRow(tx, input.noteId);
          if (current.isDeleted) this.notFound();
          const changes = {
            version: sql`${notes.version} + 1`,
            updatedAt: new Date(),
            updatedById: input.principal.userId,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.type === undefined ? {} : { noteType: this.toDatabaseType(input.type) }),
            ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
            ...(input.isTemplate === undefined ? {} : { isTemplate: input.isTemplate }),
            ...(input.isPinned === undefined ? {} : { isPinned: input.isPinned }),
            ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
            ...(input.content === undefined
              ? {}
              : { content: input.content, ...this.contentProjection(input.content) }),
          };
          const [updated] = await tx
            .update(notes)
            .set(changes)
            .where(
              and(
                eq(notes.id, input.noteId),
                eq(notes.version, input.expectedVersion),
                whereWorkspace(notes, this.tenantContext),
              ),
            )
            .returning(this.noteSelection());
          if (updated === undefined) return this.versionConflictOrNotFound(tx, input.noteId);
          // Part 55: post-update checkpoint. The optimistic CAS UPDATE won, so
          // `updated` carries the accepted post-save state for the new
          // `notes.version`. Record exactly one immutable snapshot BEFORE the
          // audit/search/embedding intents, all in this transaction. If the CAS
          // returned no row above, NOTHING is snapshotted (no misleading history
          // for a conflict/not-found). Any failure here rolls the whole note
          // update back, so no half-written note and no orphan snapshot. A
          // settings-only accepted update still checkpoints because it is an
          // accepted state change the user explicitly made (decision 4).
          await this.noteVersions.recordAcceptedState(tx, {
            noteId: input.noteId,
            workspaceId: activeWorkspaceId(this.tenantContext),
            version: updated.version,
            title: updated.title,
            content: updated.content,
            contentPlain: updated.contentPlain ?? "",
            createdById: input.principal.userId,
          });
          if (input.tagIds !== undefined) await this.replaceTags(tx, input.noteId, input.tagIds);
          await this.recordMutation(tx, "update", input.noteId, input);
          // Part 51.3: title/content/tag-affecting update — re-sync this note.
          // Tag replacement changes the index's `tags` field even when the
          // note's own row is untouched by the update statement.
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [input.noteId], {
            mutation: NOTE_DOMAIN_EVENTS.update,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          if (input.title !== undefined || input.content !== undefined)
            await this.embeddingProducer?.scheduleGeneration(
              tx,
              input.workspaceId,
              [input.noteId],
              {
                mutation: NOTE_DOMAIN_EVENTS.update,
                correlationId: input.requestId,
                actorId: input.principal.userId,
              },
            );
          // Part 60: `current.content` is the pre-update document, so only
          // mentions ADDED by this save produce an intent. A re-save of an
          // unchanged document returns before issuing any SQL — this is the
          // autosave path.
          await this.mentionProducer?.scheduleMentionNotifications(tx, input.workspaceId, {
            noteId: input.noteId,
            previousContent: current.content,
            nextContent: input.content,
            actorId: input.principal.userId,
            correlationId: input.requestId,
          });
          return updated;
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ note: await this.toDetail(row, input) });
    });
  }

  async move(input: MoveNoteServiceInput): Promise<NoteMoveResult> {
    const operation = await this.authorizeNote(input, "note.update");
    await this.authorizeCreateDestination(input, input);
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(
        async (tx) => {
          const source = await this.readRow(tx, input.noteId);
          this.assertVersion(source, input.expectedVersion);
          if (source.isDeleted) this.notFound();
          if (input.parentId === input.noteId || input.beforeNoteId === input.noteId)
            this.invalidMove();
          await this.validateContainer(tx, input, input.noteId);
          const subtreeIds = await this.noteSubtreeIds(tx, input.noteId);
          await this.lockSiblingGroups(tx, [
            source,
            input,
            ...subtreeIds.map((parentId) => ({
              projectId: source.projectId,
              folderId: source.folderId,
              parentId,
            })),
          ]);
          /*
           * THE CYCLE CHECK RUNS AFTER THE LOCK, AND THAT ORDERING IS THE FIX.
           *
           * It used to run before `lockSiblingGroups`, walking the ancestor
           * chain with unlocked reads — so `move(A under B)` and
           * `move(B under A)` could both decide "no cycle" and both commit,
           * leaving two notes pointing at each other: invisible in every
           * listing (neither is reachable from a root) and undeletable (the
           * subtree walk never terminates at one).
           *
           * The two moves DO already collide on a lock: `subtreeIds` always
           * contains the moved note itself, and `validateContainer` forces the
           * other move's destination into the same project/folder, so both
           * compute the byte-identical advisory key for the shared note. The
           * loser blocks. What was missing is that it then re-evaluated nothing.
           *
           * `read committed` gives each STATEMENT a fresh snapshot, so the
           * `readRow` walk inside `assertNoNoteCycle` now sees the winner's
           * committed re-parent and refuses. Raising the isolation level would
           * NOT do this — at `serializable` the re-read still sees the old
           * snapshot, and correctness would rest entirely on SSI aborting, which
           * needs a retry that does not exist yet on the hottest write path.
           *
           * ponytail: a note re-parented INTO this subtree between
           * `noteSubtreeIds` and the lock is still missed — stale `subtreeIds`,
           * not a cycle. Upgrade path if that ever bites: re-read the subtree
           * after the locks are held.
           */
          await this.assertNoNoteCycle(tx, input.noteId, input.parentId);
          const containerChanges =
            source.projectId !== input.projectId || source.folderId !== input.folderId;
          if (containerChanges) {
            for (const descendantId of subtreeIds.filter((id) => id !== input.noteId)) {
              await this.authorizeNote(
                {
                  principal: input.principal,
                  workspaceId: input.workspaceId,
                  noteId: descendantId,
                  requestId: input.requestId,
                },
                "note.update",
                tx,
              );
            }
          }
          if (input.parentId !== null) await this.validateContainer(tx, input, input.noteId);
          const sortOrder = await this.positionFor(
            tx,
            input,
            input.beforeNoteId ?? null,
            input.noteId,
          );
          // Resolved OUTSIDE `containerChanges` on purpose: the board column is
          // not inherited, so changing it touches exactly this one row and must
          // never trigger the descendant re-authorization/bump above.
          const boardColumnId = await this.resolveBoardColumn(tx, input, source);
          const descendantIds = subtreeIds.filter((id) => id !== input.noteId);
          if (descendantIds.length > 0 && containerChanges) {
            await tx
              .update(notes)
              .set({
                projectId: input.projectId,
                folderId: input.folderId,
                version: sql`${notes.version} + 1`,
                updatedAt: new Date(),
                updatedById: input.principal.userId,
              })
              .where(
                and(inArray(notes.id, descendantIds), whereWorkspace(notes, this.tenantContext)),
              );
          }
          const [updated] = await tx
            .update(notes)
            .set({
              projectId: input.projectId,
              folderId: input.folderId,
              parentId: input.parentId,
              boardColumnId,
              sortOrder,
              version: sql`${notes.version} + 1`,
              updatedAt: new Date(),
              updatedById: input.principal.userId,
            })
            .where(
              and(
                eq(notes.id, input.noteId),
                eq(notes.version, input.expectedVersion),
                whereWorkspace(notes, this.tenantContext),
              ),
            )
            .returning(this.noteSelection());
          if (updated === undefined) this.versionConflict();
          await this.recordMutation(tx, "move", input.noteId, input);
          // Part 51.3: re-sync the moved root and every descendant whose
          // project/folder is inherited from the root. `subtreeIds` was
          // captured BEFORE the move so the descendant IDs are still valid
          // even when the move nullifies a parent linkage. The producer
          // chunks to ≤8 per outbox row.
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, subtreeIds, {
            mutation: NOTE_DOMAIN_EVENTS.move,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          return updated;
        },
        { isolationLevel: "read committed" },
      );
      const [tagIds, taskProgress] = await Promise.all([
        this.loadTagIds(this.database.db, row.id),
        this.loadTaskProgress(this.database.db, row.id),
      ]);
      return Object.freeze({ note: Object.freeze(this.toSummary(row, tagIds, taskProgress)) });
    });
  }

  /**
   * Template copying in both directions: `asTemplate: true` is "Save as
   * template", `asTemplate: false` on a template row is "Create from
   * template". The new row copies content by value and stores no reference to
   * its source — that absence IS the "no accidental live link between copy and
   * original" guarantee, which is why no source column exists.
   *
   * Template permissions and template listings need no new server work:
   * templates are ordinary notes and reuse the `note.*` actions verbatim, and
   * `view=templates`, the `isTemplate` filter, and the `tagId` filter already
   * exist in `listConditions`. The only genuinely new rule — instantiating a
   * template requires read on the template AND create on the destination — is
   * exactly what the two authorizations below enforce, so a viewer cannot
   * instantiate and templates inside restricted projects stay invisible
   * through the existing `projectVisibility` predicate.
   */
  async copy(input: CopyNoteServiceInput): Promise<NoteCreateResult> {
    await this.authorizeNote(input, "note.read");
    const operation = await this.authorizeCreateDestination(input, input);
    return this.authorizationEntry.run(operation, async () => {
      const noteId = randomUUID();
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `note.copy:${input.workspaceId}:${input.noteId}`,
        key: input.idempotencyKey,
        payload: {
          title: input.title ?? null,
          projectId: input.projectId,
          folderId: input.folderId,
          parentId: input.parentId,
          asTemplate: input.asTemplate,
          includeTags: input.includeTags,
        },
      });
      const row = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            assertIdempotencyPayload(replay, idempotency);
            return this.readIdempotentNote(tx, replay.resourceId);
          }
          const source = await this.readRow(tx, input.noteId);
          if (source.isDeleted) this.notFound();
          await this.validateContainer(tx, input, null);
          await this.lockSiblingGroups(tx, [input]);
          // Parent placement is rechecked after the sibling-group lock so a
          // concurrent parent move cannot leave the copy behind.
          if (input.parentId !== null) await this.validateContainer(tx, input, null);
          const sortOrder = await this.positionFor(tx, input, null, null);
          await tx.insert(notes).values(
            assertWorkspaceInsertValues(
              {
                id: noteId,
                workspaceId: activeWorkspaceId(this.tenantContext),
                projectId: input.projectId,
                folderId: input.folderId,
                parentId: input.parentId,
                title: input.title ?? source.title,
                content: source.content as NoteDocument,
                // Carried across rather than recomputed, exactly like
                // `contentPlain`: the copy holds the same document, so a second
                // derivation could only ever disagree with the original.
                contentPlain: source.contentPlain ?? "",
                checklistDone: source.checklistDone,
                checklistTotal: source.checklistTotal,
                noteType: source.noteType,
                isTemplate: input.asTemplate,
                isPinned: false,
                isArchived: false,
                pageSize: source.pageSize,
                sortOrder,
                createdById: input.principal.userId,
                updatedById: input.principal.userId,
              },
              this.tenantContext,
              "note.copy",
            ),
          );
          await this.replaceTags(
            tx,
            noteId,
            input.includeTags ? await this.loadTagIds(tx, input.noteId) : [],
          );
          // Part 55: initial checkpoint for the NEW note. The copy is a brand
          // new note row whose accepted state is version 1 of its own history;
          // record one immutable snapshot of the copied title/content/plain in
          // the same transaction so the copy has a restorable baseline.
          await this.noteVersions.recordAcceptedState(tx, {
            noteId,
            workspaceId: activeWorkspaceId(this.tenantContext),
            version: 1,
            title: input.title ?? source.title,
            content: source.content,
            contentPlain: source.contentPlain ?? "",
            createdById: input.principal.userId,
          });
          await this.recordMutation(tx, "create", noteId, input);
          // Part 51.3: copy-as-create produces a brand new note row that the
          // index has never seen. Sync it so it appears in search results.
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [noteId], {
            mutation: NOTE_DOMAIN_EVENTS.create,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          await this.embeddingProducer?.scheduleGeneration(tx, input.workspaceId, [noteId], {
            mutation: NOTE_DOMAIN_EVENTS.create,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          await storeApiIdempotency(tx, idempotency, noteId);
          return this.readRow(tx, noteId);
        },
        { isolationLevel: "read committed" },
      );
      return Object.freeze({ note: await this.toDetail(row, { ...input, noteId: row.id }) });
    });
  }

  softDelete(input: VersionedNoteServiceInput): Promise<NoteDeleteResult> {
    return this.setSubtreeDeleted(input, true);
  }

  restore(input: VersionedNoteServiceInput): Promise<NoteRestoreResult> {
    return this.setSubtreeDeleted(input, false);
  }

  async permanentDelete(
    input: PermanentDeleteNoteServiceInput,
  ): Promise<NotePermanentDeleteResult> {
    const operation = await this.authorizeNote(input, "note.delete");
    return this.authorizationEntry.run(operation, async () => {
      await this.database.transaction(
        async (tx) => {
          const row = await this.readRow(tx, input.noteId);
          this.assertVersion(row, input.expectedVersion);
          if (!row.isDeleted) this.noteStateConflict();
          if (row.title !== input.expectedTitle) this.noteStateConflict();
          const subtree = await this.noteSubtreeRows(tx, input.noteId, true);
          if (subtree.some((descendant) => !descendant.isDeleted)) this.activeSubtreeConflict();
          await this.recordMutation(tx, "permanentDelete", input.noteId, input);
          // Part 51.3: capture every descendant ID BEFORE the cascade. The
          // simple self-FK ON DELETE CASCADE will remove every descendant row
          // in the next statement, after which they cannot be re-read. The
          // handler re-reads authoritative state per ID and deletes the
          // Meilisearch document for IDs that are now gone.
          await this.searchIndexProducer.scheduleSearchSync(
            tx,
            input.workspaceId,
            subtree.map((row) => row.id),
            {
              mutation: NOTE_DOMAIN_EVENTS.permanentDelete,
              correlationId: input.requestId,
              actorId: input.principal.userId,
            },
          );
          const deleted = await tx
            .delete(notes)
            .where(and(eq(notes.id, input.noteId), whereWorkspace(notes, this.tenantContext)))
            .returning({ id: notes.id });
          if (deleted.length !== 1) this.notFound();
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ id: input.noteId, permanentlyDeleted: true as const });
    });
  }

  async navigation(input: NavigationServiceInput): Promise<NoteNavigation> {
    const operation =
      input.projectId === undefined
        ? await this.authorizeWorkspaceRead(input)
        : await this.authorizationEntry.authorizeUser({
            principal: input.principal,
            workspaceId: input.workspaceId,
            action: "project.read",
            resource: { kind: "project", id: input.projectId },
            requestId: input.requestId,
          });
    return this.authorizationEntry.run(operation, async () => {
      const conditions: SQL[] = [
        whereWorkspace(notes, this.tenantContext),
        eq(notes.isDeleted, false),
        await this.projectVisibility(input.principal.userId),
      ];
      if (!input.includeArchived) conditions.push(eq(notes.isArchived, false));
      if (input.projectId !== undefined) conditions.push(eq(notes.projectId, input.projectId));
      const rows = await this.database.db
        .select({
          id: notes.id,
          projectId: notes.projectId,
          folderId: notes.folderId,
          parentId: notes.parentId,
          title: notes.title,
          noteType: notes.noteType,
          sortOrder: notes.sortOrder,
          isTemplate: notes.isTemplate,
          isPinned: notes.isPinned,
          isArchived: notes.isArchived,
          version: notes.version,
          updatedAt: notes.updatedAt,
        })
        .from(notes)
        .where(and(...conditions))
        .orderBy(
          asc(notes.projectId),
          asc(notes.folderId),
          asc(notes.parentId),
          asc(notes.sortOrder),
          asc(notes.id),
        )
        .limit(input.limit + 1);
      const items = rows.slice(0, input.limit).map((row) =>
        Object.freeze({
          id: row.id,
          projectId: row.projectId,
          folderId: row.folderId,
          parentId: row.parentId,
          title: row.title,
          type: this.fromDatabaseType(row.noteType),
          sortOrder: row.sortOrder,
          isTemplate: row.isTemplate,
          isPinned: row.isPinned,
          isArchived: row.isArchived,
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
        }),
      );
      return Object.freeze({
        items: Object.freeze(items),
        limit: input.limit,
        returned: items.length,
        truncated: rows.length > input.limit,
      });
    });
  }

  private async setSubtreeDeleted(
    input: VersionedNoteServiceInput,
    deleted: true,
  ): Promise<NoteDeleteResult>;
  private async setSubtreeDeleted(
    input: VersionedNoteServiceInput,
    deleted: false,
  ): Promise<NoteRestoreResult>;
  private async setSubtreeDeleted(
    input: VersionedNoteServiceInput,
    deleted: boolean,
  ): Promise<NoteDeleteResult | NoteRestoreResult> {
    const operation = await this.authorizeNote(input, deleted ? "note.delete" : "note.update");
    return this.authorizationEntry.run(operation, async () => {
      const at = new Date();
      const result = await this.database.transaction(
        async (tx) => {
          const root = await this.readRow(tx, input.noteId);
          this.assertVersion(root, input.expectedVersion);
          if (root.isDeleted === deleted) this.noteStateConflict();
          const subtree = await this.noteSubtreeRows(tx, input.noteId, true);
          const batchId = deleted ? randomUUID() : root.deletionBatchId;
          if (!deleted) {
            await this.assertNoDeletedAncestor(tx, root.parentId);
          }
          const ids = deleted
            ? subtree.filter((row) => !row.isDeleted).map((row) => row.id)
            : batchId === null
              ? [root.id]
              : subtree
                  .filter((row) => row.isDeleted && row.deletionBatchId === batchId)
                  .map((row) => row.id);
          if (ids.length === 0) this.noteStateConflict();
          await this.lockSiblingGroups(
            tx,
            ids.map((parentId) => ({
              projectId: root.projectId,
              folderId: root.folderId,
              parentId,
            })),
          );
          if (!deleted) {
            for (const descendantId of ids.filter((id) => id !== input.noteId)) {
              await this.authorizeNote(
                {
                  principal: input.principal,
                  workspaceId: input.workspaceId,
                  noteId: descendantId,
                  requestId: input.requestId,
                },
                "note.update",
                tx,
              );
            }
          }
          const updated = await tx
            .update(notes)
            .set({
              isDeleted: deleted,
              deletedAt: deleted ? at : null,
              deletionBatchId: deleted ? batchId : null,
              version: sql`${notes.version} + 1`,
              updatedAt: at,
              updatedById: input.principal.userId,
            })
            .where(
              and(
                inArray(notes.id, ids),
                deleted ? eq(notes.isDeleted, false) : eq(notes.isDeleted, true),
                whereWorkspace(notes, this.tenantContext),
              ),
            )
            .returning({ id: notes.id, version: notes.version });
          const updatedRoot = updated.find((row) => row.id === input.noteId);
          if (updatedRoot === undefined) this.versionConflict();
          await this.recordMutation(tx, deleted ? "delete" : "restore", input.noteId, input);
          // Part 51.3: re-sync every affected note in the subtree. `ids` was
          // computed BEFORE the update from the subtree rows; the IDs are
          // still valid (soft delete/restore only flips flags). For soft
          // delete the handler's authoritative read finds the rows marked
          // isDeleted=true and removes them from the index; for restore the
          // read finds live rows and re-upserts them.
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, ids, {
            mutation: NOTE_DOMAIN_EVENTS[deleted ? "delete" : "restore"],
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
          return { affected: updated.length, version: updatedRoot.version };
        },
        { isolationLevel: "serializable" },
      );
      return deleted
        ? Object.freeze({
            id: input.noteId,
            deleted: true as const,
            affected: result.affected,
            version: result.version,
            deletedAt: at.toISOString(),
          })
        : Object.freeze({
            id: input.noteId,
            restored: true as const,
            affected: result.affected,
            version: result.version,
          });
    });
  }

  /*
   * FOLDERS LIVE IN `FoldersService`; these four are delegates.
   *
   * `FoldersController` is constructed in `notes.controller.test.ts` as
   * `{ deleteFolder } as unknown as NotesService`, and `notes.trpc.ts` calls all
   * four on this service. Re-pointing either at `FoldersService` would turn a
   * file split into a transport change and break a controller test that has
   * nothing to do with folders.
   */
  listFolders(input: ListFoldersServiceInput): Promise<FolderPage> {
    return this.requireFolders().listFolders(input);
  }

  createFolder(input: CreateFolderServiceInput): Promise<FolderCreateResult> {
    return this.requireFolders().createFolder(input);
  }

  updateFolder(input: UpdateFolderServiceInput): Promise<FolderUpdateResult> {
    return this.requireFolders().updateFolder(input);
  }

  deleteFolder(input: DeleteFolderServiceInput): Promise<FolderDeleteResult> {
    return this.requireFolders().deleteFolder(input);
  }

  /**
   * `foldersService` is the TENTH constructor parameter and `@Optional()`, so the
   * eighteen unit-test constructions that pass five or six arguments keep
   * working. None of them exercises a folder path — verified — so an absent
   * collaborator is unreachable rather than merely unlikely, and it says so.
   */
  private requireFolders(): FoldersService {
    if (this.foldersService === undefined) {
      throw new Error("FoldersService is not wired; folder use cases are unavailable.");
    }
    return this.foldersService;
  }

  private async authorizeWorkspaceRead(input: ScopedInput) {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "workspace.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
  }

  /**
   * `db` is passed ONLY by the two callers that authorize from inside a
   * transaction they already hold — the descendant re-checks in `move()` and in
   * the delete/restore path. Without it those reads take a SECOND pool
   * connection while the first is still open, so at the default pool size of 10
   * ten concurrent moves hold all ten and then each waits for a connection only
   * another waiter could release. Every other caller omits it and is unchanged.
   */
  private authorizeNote(
    input: NoteSelector,
    action: "note.read" | "note.update" | "note.delete" | "note.tag" | "export.create",
    db?: AuthorizationRunner,
  ) {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action,
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
      db,
    });
  }

  private authorizeCreateDestination(input: ScopedInput, container: Container) {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "note.create",
      resource:
        container.parentId !== null
          ? { kind: "note", id: container.parentId }
          : container.projectId !== null
            ? { kind: "project", id: container.projectId }
            : { kind: "workspace" },
      requestId: input.requestId,
    });
  }

  private async listConditions(input: ListNotesServiceInput): Promise<SQL[]> {
    const conditions: SQL[] = [
      whereWorkspace(notes, this.tenantContext),
      await this.projectVisibility(input.principal.userId),
      eq(notes.isDeleted, input.view === "trash"),
    ];
    if (input.scope === "project" && input.projectId !== undefined)
      conditions.push(eq(notes.projectId, input.projectId));
    if (input.scope === "workspace-root") conditions.push(isNull(notes.projectId));
    if (input.folderId !== undefined) conditions.push(eq(notes.folderId, input.folderId));
    if (input.rootFolder === true) conditions.push(isNull(notes.folderId));
    if (input.parentId !== undefined) conditions.push(eq(notes.parentId, input.parentId));
    if (input.rootParent === true) conditions.push(isNull(notes.parentId));
    if (input.type !== undefined)
      conditions.push(eq(notes.noteType, this.toDatabaseType(input.type)));
    if (input.view === "pinned") conditions.push(eq(notes.isPinned, true));
    if (input.view === "templates") conditions.push(eq(notes.isTemplate, true));
    if (input.isTemplate !== undefined) conditions.push(eq(notes.isTemplate, input.isTemplate));
    if (input.isPinned !== undefined) conditions.push(eq(notes.isPinned, input.isPinned));
    if (input.isArchived !== undefined) conditions.push(eq(notes.isArchived, input.isArchived));
    if (input.tagId !== undefined) {
      conditions.push(
        exists(
          this.database.db
            .select({ noteId: noteTags.noteId })
            .from(noteTags)
            .innerJoin(tags, eq(tags.id, noteTags.tagId))
            .where(
              and(
                eq(noteTags.noteId, notes.id),
                eq(noteTags.tagId, input.tagId),
                whereWorkspace(tags, this.tenantContext),
              ),
            ),
        ),
      );
    }
    return conditions;
  }

  private async projectVisibility(userId: string): Promise<SQL> {
    const [membership] = await this.database.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1);
    if (membership === undefined) this.notFound();
    if (membership.role === "owner" || membership.role === "admin") return sql`true`;
    const actorGrant = this.database.db
      .select({ id: projectAccess.id })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, notes.projectId), eq(projectAccess.userId, userId)));
    const visibleProject = this.database.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, notes.projectId),
          whereWorkspace(projects, this.tenantContext),
          or(eq(projects.isRestricted, false), exists(actorGrant)),
        ),
      );
    return or(isNull(notes.projectId), exists(visibleProject)) as SQL;
  }

  private async validateContainer(
    tx: DatabaseTransaction,
    container: Container,
    movingNoteId: string | null,
  ): Promise<void> {
    if (container.projectId !== null) {
      const [project] = await tx
        .select({ id: projects.id, status: projects.status })
        .from(projects)
        .where(
          and(eq(projects.id, container.projectId), whereWorkspace(projects, this.tenantContext)),
        )
        .limit(1);
      if (project === undefined || project.status === "archived") this.notFound();
    }
    if (container.folderId !== null) await this.requireFolders().readFolder(tx, container.folderId);
    if (container.parentId !== null) {
      if (container.parentId === movingNoteId) this.invalidMove();
      const parent = await this.readRow(tx, container.parentId);
      if (parent.isDeleted || !this.sameContainer(parent, container)) this.notFound();
    }
  }

  private async assertNoNoteCycle(
    tx: DatabaseTransaction,
    noteId: string,
    parentId: string | null,
  ): Promise<void> {
    const seen = new Set<string>();
    let cursor = parentId;
    while (cursor !== null) {
      if (cursor === noteId || seen.has(cursor)) this.invalidMove();
      seen.add(cursor);
      const ancestor = await this.readRow(tx, cursor);
      cursor = ancestor.parentId;
    }
  }

  /**
   * "Omitted means keep", with exactly one exception.
   *
   * A cross-project move that would strand a project-scoped column CLEARS the
   * column instead of failing: the board column is an orthogonal axis and must
   * never be the reason a hierarchy change is rejected. The returned summary
   * then carries `boardColumnId: null`, so the UI can announce the move to
   * "No column" rather than silently disagreeing with the server.
   *
   * An explicitly NAMED incompatible column is still a 404 — the caller asked
   * for a column that does not exist in the destination, which is a mistake to
   * report, not one to paper over.
   */
  private async resolveBoardColumn(
    tx: DatabaseTransaction,
    input: MoveNoteServiceInput,
    source: NoteRow,
  ): Promise<string | null> {
    if (input.boardColumnId !== undefined) {
      await this.assertBoardColumn(tx, input.boardColumnId, input.projectId);
      return input.boardColumnId;
    }
    if (source.boardColumnId === null || input.projectId === source.projectId)
      return source.boardColumnId;
    const column = await this.readBoardColumn(tx, source.boardColumnId);
    return column?.projectId === null ? source.boardColumnId : null;
  }

  /**
   * Mirrors `TasksService.assertCustomStatus`: the note board and the task
   * board share one column vocabulary, so they must share one fitting rule. A
   * workspace-wide column (`project_id IS NULL`) fits any note; a
   * project-scoped one fits only notes in that project.
   *
   * A foreign, other-tenant, or unknown id is a 404, never a 403: the
   * workspace-scoped read simply finds nothing, which is exactly how another
   * tenant's column looks from inside this workspace, so the endpoint cannot
   * be used as a cross-tenant existence oracle.
   */
  private async assertBoardColumn(
    tx: DatabaseTransaction,
    boardColumnId: string | null,
    projectId: string | null,
  ): Promise<void> {
    if (boardColumnId === null) return;
    const column = await this.readBoardColumn(tx, boardColumnId);
    if (column === undefined) this.notFound();
    if (column.projectId !== null && column.projectId !== projectId) this.notFound();
  }

  private async readBoardColumn(
    tx: DatabaseTransaction,
    boardColumnId: string,
  ): Promise<{ readonly projectId: string | null } | undefined> {
    const [column] = await tx
      .select({ projectId: taskStatuses.projectId })
      .from(taskStatuses)
      .where(
        and(eq(taskStatuses.id, boardColumnId), whereWorkspace(taskStatuses, this.tenantContext)),
      )
      .limit(1);
    return column;
  }

  private async assertTags(tx: DatabaseTransaction, tagIds: readonly string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const rows = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(inArray(tags.id, [...tagIds]), whereWorkspace(tags, this.tenantContext)));
    if (rows.length !== tagIds.length) this.notFound();
  }

  private async replaceTags(
    tx: DatabaseTransaction,
    noteId: string,
    tagIds: readonly string[],
  ): Promise<void> {
    await tx.delete(noteTags).where(eq(noteTags.noteId, noteId));
    if (tagIds.length > 0) {
      await tx.insert(noteTags).values(tagIds.map((tagId) => ({ noteId, tagId })));
    }
  }

  private async lockSiblingGroups(
    tx: DatabaseTransaction,
    containers: readonly Container[],
  ): Promise<void> {
    const keys = [...new Set(containers.map((container) => this.containerKey(container)))].sort();
    for (const key of keys) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }
  }

  private async positionFor(
    tx: DatabaseTransaction,
    container: Container,
    beforeNoteId: string | null,
    excludedNoteId: string | null,
  ): Promise<number> {
    let siblings = await this.loadSiblings(tx, container, excludedNoteId);
    if (this.requiresRenormalization(siblings)) {
      siblings = await this.renormalize(tx, siblings);
    }
    let position = this.calculatePosition(siblings, beforeNoteId);
    if (
      !Number.isFinite(position) ||
      Math.abs(position) > Number.MAX_SAFE_INTEGER / 4 ||
      this.gapExhausted(siblings, beforeNoteId, position)
    ) {
      siblings = await this.renormalize(tx, siblings);
      position = this.calculatePosition(siblings, beforeNoteId);
    }
    if (!Number.isFinite(position))
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "ORDER_CONFLICT",
        message: "The note order changed. Retry the operation.",
      });
    return position;
  }

  private async loadSiblings(
    tx: DatabaseTransaction,
    container: Container,
    excludedNoteId: string | null,
  ): Promise<Array<{ id: string; sortOrder: number; isDeleted: boolean }>> {
    const conditions = [
      whereWorkspace(notes, this.tenantContext),
      ...this.containerConditions(container),
    ];
    const rows = await tx
      .select({ id: notes.id, sortOrder: notes.sortOrder, isDeleted: notes.isDeleted })
      .from(notes)
      .where(and(...conditions))
      .orderBy(asc(notes.sortOrder), asc(notes.id));
    return excludedNoteId === null ? rows : rows.filter((row) => row.id !== excludedNoteId);
  }

  private calculatePosition(
    siblings: readonly { id: string; sortOrder: number; isDeleted: boolean }[],
    beforeNoteId: string | null,
  ): number {
    if (beforeNoteId !== null) {
      const index = siblings.findIndex((row) => row.id === beforeNoteId);
      if (index < 0) this.notFound();
      if (siblings[index]!.isDeleted) this.notFound();
      if (index === 0) return siblings[0]!.sortOrder - 1;
      return (siblings[index - 1]!.sortOrder + siblings[index]!.sortOrder) / 2;
    }
    if (siblings.length === 0) return 1;
    return siblings[siblings.length - 1]!.sortOrder + 1;
  }

  private gapExhausted(
    siblings: readonly { id: string; sortOrder: number; isDeleted: boolean }[],
    beforeNoteId: string | null,
    position: number,
  ): boolean {
    if (beforeNoteId === null || siblings.length === 0)
      return position === siblings.at(-1)?.sortOrder;
    const index = siblings.findIndex((row) => row.id === beforeNoteId);
    if (index <= 0) return position === siblings[0]?.sortOrder;
    return position === siblings[index - 1]?.sortOrder || position === siblings[index]?.sortOrder;
  }

  private requiresRenormalization(rows: readonly { sortOrder: number }[]): boolean {
    const values = new Set<number>();
    for (const row of rows) {
      if (!Number.isFinite(row.sortOrder) || values.has(row.sortOrder)) return true;
      values.add(row.sortOrder);
    }
    return false;
  }

  private async renormalize(
    tx: DatabaseTransaction,
    rows: readonly { id: string; sortOrder: number; isDeleted: boolean }[],
  ): Promise<Array<{ id: string; sortOrder: number; isDeleted: boolean }>> {
    const normalized: Array<{ id: string; sortOrder: number; isDeleted: boolean }> = [];
    for (const [index, row] of rows.entries()) {
      const sortOrder = index + 1;
      if (row.sortOrder !== sortOrder) {
        /*
         * `sortOrder` ONLY — no version bump, no timestamp, no actor.
         *
         * Renumbering is bookkeeping forced on a sibling by someone ELSE's
         * insert, not an edit to it. `TasksService.renormalize` already refuses
         * to touch `updatedAt` for exactly that reason; notes additionally bumped
         * `version`, which is the optimistic-concurrency token, and that was
         * actively harmful in two places:
         *
         *   - `useNoteAutosave` holds `note.version`, so renumbering a note the
         *     user never opened turned their next save into a spurious
         *     "the note changed" conflict.
         *   - `note-collaboration.service.ts` compares `projectedNoteVersion`
         *     against `note.version` and answers `version_mismatch`, forcing an
         *     EPOCH REBUILD of a live collaborative document because an
         *     unrelated sibling ran out of sort-order gaps.
         *
         * Nothing reads `version` to detect a reorder — order is read from
         * `sortOrder` directly — so the bump had no consumer at all.
         */
        await tx
          .update(notes)
          .set({ sortOrder })
          .where(and(eq(notes.id, row.id), whereWorkspace(notes, this.tenantContext)));
      }
      normalized.push({ id: row.id, sortOrder, isDeleted: row.isDeleted });
    }
    return normalized;
  }

  private containerConditions(container: Container): SQL[] {
    return [
      container.projectId === null
        ? isNull(notes.projectId)
        : eq(notes.projectId, container.projectId),
      container.folderId === null ? isNull(notes.folderId) : eq(notes.folderId, container.folderId),
      container.parentId === null ? isNull(notes.parentId) : eq(notes.parentId, container.parentId),
    ];
  }

  private async noteSubtreeIds(tx: DatabaseTransaction, rootId: string): Promise<string[]> {
    return (await this.noteSubtreeRows(tx, rootId, false)).map((row) => row.id);
  }

  private async noteSubtreeRows(
    tx: DatabaseTransaction,
    rootId: string,
    lock: boolean,
  ): Promise<
    Array<{
      id: string;
      parentId: string | null;
      isDeleted: boolean;
      deletionBatchId: string | null;
    }>
  > {
    const workspaceId = activeWorkspaceId(this.tenantContext);
    // Recursive descent seeded on the ROOT, not a scan of the whole workspace.
    //
    // This used to select every note row in the workspace and walk the edges in
    // memory — and when `lock` was set it took `FOR UPDATE` on all of them. In a
    // workspace with tens of thousands of notes, trashing one three-note branch
    // row-locked the entire tenant until the transaction committed, blocking
    // every concurrent edit and autosave and, at `serializable`, aborting many
    // of them outright.
    //
    // `cycle id set is_cycle using cycle_path` is PostgreSQL's native cycle
    // detection. It is what preserves the two behaviours a naive rewrite
    // destroys: a bare `union all` spins forever on a corrupt `parent_id` loop,
    // and `union` swallows it silently. Here the row that closes the loop is
    // emitted once, flagged, and not expanded — so the walk terminates and the
    // caller still gets 400 NOTE_HIERARCHY_INVALID.
    //
    // `whereWorkspace` builds a Drizzle `SQL` for the query builder and does not
    // compose into a raw template, so the workspace id is bound on BOTH terms
    // explicitly — the same shape the other raw-SQL sites in this codebase use.
    const traversal = await tx.execute(sql`
      with recursive subtree as (
        select id, parent_id, is_deleted, deletion_batch_id
        from notes
        where workspace_id = ${workspaceId} and id = ${rootId}
        union all
        select child.id, child.parent_id, child.is_deleted, child.deletion_batch_id
        from notes child
        join subtree parent on child.parent_id = parent.id
        where child.workspace_id = ${workspaceId}
      ) cycle id set is_cycle using cycle_path
      select id,
             parent_id as "parentId",
             is_deleted as "isDeleted",
             deletion_batch_id as "deletionBatchId",
             is_cycle as "isCycle"
      from subtree
    `);
    const traversed = ((traversal as { readonly rows?: readonly unknown[] }).rows ?? []) as Array<{
      id: string;
      parentId: string | null;
      isDeleted: boolean;
      deletionBatchId: string | null;
      isCycle: boolean;
    }>;
    // An empty result means the root itself is not in this workspace. The old
    // in-memory walk reached the same verdict via `byId.get(rootId) === undefined`.
    if (traversed.length === 0) this.notFound();
    if (traversed.some((row) => row.isCycle)) this.invalidMove();

    if (lock) {
      // A locking clause cannot be applied to a WITH query, so the lock is its
      // own statement over the ids the traversal found. Both callers that pass
      // `lock` run at `serializable`, so this statement shares the traversal's
      // snapshot: a row another transaction changed since raises 40001 exactly
      // as the previous single-statement `for update` did.
      //
      // Ordered by id so two overlapping subtree locks acquire in the same
      // sequence and cannot deadlock — the same discipline as the sorted
      // advisory keys in `lockSiblingGroups`.
      //
      // ponytail: the lock is now subtree-scoped, so it no longer accidentally
      // serializes unrelated note mutations across the workspace. Nothing
      // depended on that: `move()` re-evaluates after acquiring its own locks.
      //
      // The stated upgrade path here USED to be "raise `move()` to
      // `serializable`, or lock the destination parent row". Both are the wrong
      // answer and neither is needed: the concurrent-cycle race turned out to be
      // a statement-ORDERING bug, closed by running `assertNoNoteCycle` after
      // `lockSiblingGroups` rather than before it. See the comment there — it
      // also explains why raising the isolation level would not have worked.
      // What remains unprotected is a note re-parented INTO this subtree between
      // `noteSubtreeIds` and the lock, which is stale membership, not a cycle.
      await tx
        .select({ id: notes.id })
        .from(notes)
        .where(
          and(
            inArray(
              notes.id,
              traversed.map((row) => row.id),
            ),
            whereWorkspace(notes, this.tenantContext),
          ),
        )
        .orderBy(asc(notes.id))
        .for("update");
    }
    return traversed.map(({ id, parentId, isDeleted, deletionBatchId }) => ({
      id,
      parentId,
      isDeleted,
      deletionBatchId,
    }));
  }

  private async assertNoDeletedAncestor(
    tx: DatabaseTransaction,
    parentId: string | null,
  ): Promise<void> {
    const seen = new Set<string>();
    let cursor = parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) this.invalidMove();
      seen.add(cursor);
      const ancestor = await this.readRow(tx, cursor);
      if (ancestor.isDeleted) this.deletedAncestorConflict();
      cursor = ancestor.parentId;
    }
  }

  private async readDatabaseRow(noteId: string): Promise<NoteRow> {
    const [row] = await this.database.db
      .select(this.noteSelection())
      .from(notes)
      .where(and(eq(notes.id, noteId), whereWorkspace(notes, this.tenantContext)))
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }

  private async readRow(tx: DatabaseTransaction, noteId: string): Promise<NoteRow> {
    const [row] = await tx
      .select(this.noteSelection())
      .from(notes)
      .where(and(eq(notes.id, noteId), whereWorkspace(notes, this.tenantContext)))
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }

  private async readIdempotentNote(tx: DatabaseTransaction, noteId: string): Promise<NoteRow> {
    try {
      return await this.readRow(tx, noteId);
    } catch (error: unknown) {
      if (error instanceof ApiHttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
        throw new ApiHttpException(HttpStatus.CONFLICT, {
          code: "IDEMPOTENT_RESULT_UNAVAILABLE",
          message: "The idempotent note result is no longer available.",
        });
      }
      throw error;
    }
  }

  private async loadTagIds(
    db: DatabaseService["db"] | DatabaseTransaction,
    noteId: string,
  ): Promise<string[]> {
    const map = await this.loadTagMap(db, [noteId]);
    return map.get(noteId) ?? [];
  }

  /**
   * Everything derived from a note's document, computed in ONE place.
   *
   * `content_plain` and the two checklist counters are all projections of the
   * same jsonb, and every writer of `content` must write all three or the list
   * view starts reporting a progress bar for a document that no longer has one.
   * Returning them together makes forgetting one a type error.
   */
  private contentProjection(content: NoteDocument): {
    readonly contentPlain: string;
    readonly checklistDone: number;
    readonly checklistTotal: number;
  } {
    const checklist = countChecklist(content);
    return {
      contentPlain: extractNoteContentPlain(content),
      checklistDone: checklist.done,
      checklistTotal: checklist.total,
    };
  }

  /**
   * Task counts for many notes in ONE grouped query, mirroring `loadTagMap`.
   * A per-row count would make a 25-note page 25 extra round trips.
   *
   * The aggregates come from `sql-aggregates` so a note's progress and a
   * project's rollup cannot disagree about what "done" means.
   */
  private async loadTaskProgressMap(
    db: DatabaseService["db"] | DatabaseTransaction,
    noteIds: readonly string[],
  ): Promise<Map<string, Progress>> {
    const result = new Map<string, Progress>();
    if (noteIds.length === 0) return result;
    const rows = await db
      .select({ noteId: tasks.noteId, done: taskDoneCount(), total: taskOpenTotalCount() })
      .from(tasks)
      .where(and(inArray(tasks.noteId, [...noteIds]), whereWorkspace(tasks, this.tenantContext)))
      .groupBy(tasks.noteId);
    for (const row of rows) {
      if (row.noteId !== null) result.set(row.noteId, { done: row.done, total: row.total });
    }
    return result;
  }

  private async loadTaskProgress(
    db: DatabaseService["db"] | DatabaseTransaction,
    noteId: string,
  ): Promise<Progress> {
    return (await this.loadTaskProgressMap(db, [noteId])).get(noteId) ?? NO_PROGRESS;
  }

  private async loadTagMap(
    db: DatabaseService["db"] | DatabaseTransaction,
    noteIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (noteIds.length === 0) return result;
    const rows = await db
      .select({ noteId: noteTags.noteId, tagId: noteTags.tagId })
      .from(noteTags)
      .innerJoin(tags, eq(tags.id, noteTags.tagId))
      .where(and(inArray(noteTags.noteId, [...noteIds]), whereWorkspace(tags, this.tenantContext)))
      .orderBy(asc(noteTags.noteId), asc(noteTags.tagId));
    for (const row of rows) {
      const list = result.get(row.noteId) ?? [];
      list.push(row.tagId);
      result.set(row.noteId, list);
    }
    return result;
  }

  private async toDetail(row: NoteRow, input: NoteSelector): Promise<NoteDetail> {
    const [tagIds, taskProgress, canUpdate, canDelete, canExport] = await Promise.all([
      this.loadTagIds(this.database.db, row.id),
      this.loadTaskProgress(this.database.db, row.id),
      this.can(input, "note.update"),
      this.can(input, "note.delete"),
      this.can(input, "export.create"),
    ]);
    return Object.freeze({
      ...this.toSummary(row, tagIds, taskProgress),
      content: row.content as NoteDocument,
      contentPlain: row.contentPlain ?? "",
      createdById: row.createdById,
      updatedById: row.updatedById,
      currentActorId: input.principal.userId,
      capabilities: Object.freeze({ canUpdate, canDelete, canShare: canUpdate, canExport }),
    });
  }

  private toSummary(row: NoteRow, tagIds: readonly string[], taskProgress: Progress): NoteSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      location: row.projectId === null ? "workspace-root" : "project",
      projectId: row.projectId,
      folderId: row.folderId,
      parentId: row.parentId,
      boardColumnId: row.boardColumnId,
      title: row.title,
      type: this.fromDatabaseType(row.noteType),
      pageSize: row.pageSize === "letter" ? "letter" : "a4",
      sortOrder: row.sortOrder,
      isTemplate: row.isTemplate,
      isPinned: row.isPinned,
      isArchived: row.isArchived,
      isDeleted: row.isDeleted,
      tagIds: Object.freeze([...tagIds]),
      progress: Object.freeze({
        checklist: Object.freeze({ done: row.checklistDone, total: row.checklistTotal }),
        tasks: Object.freeze({ done: taskProgress.done, total: taskProgress.total }),
      }),
      version: row.version,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private noteSelection() {
    return {
      id: notes.id,
      workspaceId: notes.workspaceId,
      projectId: notes.projectId,
      folderId: notes.folderId,
      parentId: notes.parentId,
      boardColumnId: notes.boardColumnId,
      title: notes.title,
      content: notes.content,
      contentPlain: notes.contentPlain,
      checklistDone: notes.checklistDone,
      checklistTotal: notes.checklistTotal,
      noteType: notes.noteType,
      isTemplate: notes.isTemplate,
      isPinned: notes.isPinned,
      isArchived: notes.isArchived,
      isDeleted: notes.isDeleted,
      deletedAt: notes.deletedAt,
      deletionBatchId: notes.deletionBatchId,
      version: notes.version,
      pageSize: notes.pageSize,
      sortOrder: notes.sortOrder,
      createdById: notes.createdById,
      updatedById: notes.updatedById,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    };
  }

  private versionSelection() {
    return {
      id: noteVersions.id,
      version: noteVersions.version,
      title: noteVersions.title,
      content: noteVersions.content,
      createdAt: noteVersions.createdAt,
      authorId: users.id,
      authorName: users.name,
      currentVersion: notes.version,
      latestCheckpointVersion: sql<number>`(
        select max(latest_version.version)
        from note_versions latest_version
        where latest_version.note_id = ${noteVersions.noteId}
      )`,
    };
  }

  private async readVersionRow(database: VersionDatabase, input: NoteVersionSelector) {
    const [row] = await database
      .select(this.versionSelection())
      .from(noteVersions)
      .innerJoin(
        notes,
        and(
          eq(notes.id, noteVersions.noteId),
          eq(notes.workspaceId, input.workspaceId),
          eq(notes.isDeleted, false),
        ),
      )
      .innerJoin(users, eq(users.id, noteVersions.createdById))
      .where(and(eq(noteVersions.id, input.versionId), eq(noteVersions.noteId, input.noteId)))
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }

  private async versionSummaryForVersion(
    workspaceId: string,
    noteId: string,
    version: number,
  ): Promise<NoteVersionSummary> {
    const [row] = await this.database.db
      .select(this.versionSelection())
      .from(noteVersions)
      .innerJoin(notes, and(eq(notes.id, noteVersions.noteId), eq(notes.workspaceId, workspaceId)))
      .innerJoin(users, eq(users.id, noteVersions.createdById))
      .where(and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, version)))
      .limit(1);
    if (row === undefined) this.notFound();
    return this.toVersionSummary(row);
  }

  private toVersionSummary(row: {
    readonly id: string;
    readonly version: number;
    readonly title: string;
    readonly createdAt: Date;
    readonly authorId: string;
    readonly authorName: string;
    readonly currentVersion: number;
    readonly latestCheckpointVersion: number;
  }): NoteVersionSummary {
    return Object.freeze({
      id: row.id,
      version: row.version,
      title: row.title,
      author: Object.freeze({ id: row.authorId, name: row.authorName }),
      createdAt: row.createdAt.toISOString(),
      // Structural note mutations can advance notes.version without changing
      // recoverable content or adding a checkpoint. The latest accepted
      // checkpoint, not numeric equality with notes.version, is therefore the
      // history UI's current content state.
      isCurrent: row.version === row.latestCheckpointVersion,
    });
  }

  private migrateHistoricalContent(content: unknown): NoteDocument {
    try {
      return migrateNoteDocument(content).doc;
    } catch {
      throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: "UNPROCESSABLE_ENTITY",
        message: "This historical version cannot be safely previewed or restored.",
      });
    }
  }

  private invalidVersionRequest(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The version request is invalid.",
    });
  }

  private currentVersionConflict(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "NOTE_STATE_CONFLICT",
      message: "The selected checkpoint is already current.",
    });
  }

  private recordMutation(
    tx: DatabaseTransaction,
    mutation: NoteMutation,
    entityId: string,
    input: ScopedInput,
  ): Promise<void> {
    return recordNoteMutation(
      tx,
      { tenantContext: this.tenantContext, webhookProducer: this.webhookProducer },
      mutation,
      entityId,
      input,
    );
  }

  private async versionConflictOrNotFound(tx: DatabaseTransaction, noteId: string): Promise<never> {
    await this.readRow(tx, noteId);
    return this.versionConflict();
  }

  private assertVersion(row: NoteRow, expectedVersion: number): void {
    if (row.version !== expectedVersion) this.versionConflict();
  }

  private versionConflict(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "VERSION_CONFLICT",
      message: "The note changed. Refresh it and retry.",
    });
  }

  private noteStateConflict(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "NOTE_STATE_CONFLICT",
      message: "The note is not in the required lifecycle state.",
    });
  }

  private deletedAncestorConflict(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "NOTE_ANCESTOR_DELETED",
      message: "Restore the deleted ancestor before restoring this note.",
    });
  }

  private activeSubtreeConflict(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "NOTE_SUBTREE_ACTIVE",
      message: "The note subtree contains active notes and cannot be permanently deleted.",
    });
  }

  private async can(
    input: NoteSelector,
    action: "note.update" | "note.delete" | "export.create",
  ): Promise<boolean> {
    try {
      await this.authorizeNote(input, action);
      return true;
    } catch (error: unknown) {
      if (error instanceof AuthorizationDeniedError) return false;
      throw error;
    }
  }

  private invalidMove(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "NOTE_HIERARCHY_INVALID",
      message: "The requested note hierarchy is invalid.",
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }

  private toDatabaseType(type: NoteType): "document" | "task" {
    return type === "task-list" ? "task" : "document";
  }

  private fromDatabaseType(type: "document" | "task"): NoteType {
    return type === "task" ? "task-list" : "document";
  }

  private sameContainer(left: Container, right: Container): boolean {
    return left.projectId === right.projectId && left.folderId === right.folderId;
  }

  private containerKey(container: Container): string {
    return [
      activeWorkspaceId(this.tenantContext),
      container.projectId ?? "root",
      container.folderId ?? "unfiled",
      container.parentId ?? "top",
    ].join(":");
  }
}
