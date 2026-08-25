// Part 60 — inline comments and mentions: the application service.
//
// WHAT LIVES HERE. Every comment read/write goes through this service so the
// transports (`comments.controller.ts` for REST, `comments.trpc.ts` for the
// first-party router) stay thin and share one policy/SQL authority (ADR 0002).
//
// TENANT SCOPE. `comments` has NO `workspace_id` column — it is a child of
// `notes` (see `database/schema/comments.ts`). Every statement therefore joins
// `notes` and applies `whereWorkspace(notes, ...)`, and every id lookup that
// misses returns 404 rather than 403 so a foreign-workspace comment id cannot
// be probed for existence.
//
// THE SERVER NEVER REMAPS ANCHORS. Anchors are stored exactly as the client
// sent them and echoed back unchanged. Only a client holding the live Y.Doc can
// resolve `relFrom`/`relTo`; re-deriving them here would be a second
// implementation of `y-prosemirror`'s mapping for no benefit.

import { randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { commentAnchorSchema } from "@notted/shared-validators";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from "../database/database.service";
import { comments, notes, users } from "../database/schema";
import { RealtimeRoomService } from "../realtime/realtime-room.service";
import { REALTIME_EVENTS } from "../realtime/realtime.contracts";
import { activeWorkspaceId, TenantContextService, whereWorkspace } from "../tenant";

import type {
  AuthenticatedPrincipal,
  CommentAnchor,
  CommentChangedEvent,
  CommentDeleteResult,
  CommentMutationResult,
  CommentPage,
  CommentSummary,
  CommentThread,
} from "@notted/shared-types";

/**
 * Both handles are `PgDatabase` subtypes over the same schema, so one signature
 * serves plain reads and transactional read-backs.
 */
type CommentQueryRunner = Database | DatabaseTransaction;

/** `resolved_by_id` needs its own `users` join alongside `created_by_id`. */
const resolvers = alias(users, "comment_resolvers");

export interface CommentScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly requestId?: string | null;
}

export interface ListCommentsServiceInput extends CommentScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly status: "all" | "open" | "resolved";
}

export interface CreateCommentServiceInput extends CommentScopedInput {
  readonly content: string;
  readonly parentId: string | null;
  readonly anchor: CommentAnchor | null;
  readonly idempotencyKey: string;
}

export interface UpdateCommentServiceInput extends CommentScopedInput {
  readonly commentId: string;
  readonly content: string;
}

export interface DeleteCommentServiceInput extends CommentScopedInput {
  readonly commentId: string;
}

export interface SetCommentResolutionServiceInput extends CommentScopedInput {
  readonly commentId: string;
  readonly isResolved: boolean;
}

interface CommentRow {
  readonly id: string;
  readonly noteId: string;
  readonly parentId: string | null;
  readonly content: string;
  readonly createdById: string;
  readonly createdByName: string;
  readonly isResolved: boolean;
  readonly resolvedAt: Date | null;
  readonly resolvedById: string | null;
  readonly resolvedByName: string | null;
  readonly anchorKey: string | null;
  readonly anchorFrom: number | null;
  readonly anchorTo: number | null;
  readonly anchorMetadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly realtimeRooms: RealtimeRoomService,
  ) {}

  /**
   * Threads on a note: top-level comments paginated oldest-first (how every
   * discussion UI reads), each carrying its replies, also oldest-first.
   * `openCount` counts UNRESOLVED top-level threads across all pages, so the
   * sidebar badge does not change as the reader pages.
   *
   * WHY `note.read` AND NOT `comment.read`. `comment.read` is declared over a
   * `comment` RESOURCE (`authorization-policy.service.ts` action→kind map), and
   * a listing has no comment id to authorize against. The honest reading of the
   * existing contract is that the readable thing here is the NOTE: anyone who
   * may read the note may read its comment thread. This is not a workaround —
   * inventing a `comment.list` action would be the change to the contract.
   */
  async list(input: ListCommentsServiceInput): Promise<CommentPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "note.read",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const statusCondition =
        input.status === "all" ? undefined : eq(comments.isResolved, input.status === "resolved");
      const roots = await this.selectComments(this.database.db)
        .where(
          and(
            eq(comments.noteId, input.noteId),
            isNull(comments.parentId),
            statusCondition,
            whereWorkspace(notes, this.tenantContext),
          ),
        )
        .orderBy(asc(comments.createdAt), asc(comments.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);

      const visible = roots.slice(0, input.limit);
      const replies = await this.readReplies(visible.map((row) => row.id));
      const [countRow] = await this.database.db
        .select({ count: sql<number>`count(*)::int` })
        .from(comments)
        .innerJoin(notes, eq(notes.id, comments.noteId))
        .where(
          and(
            eq(comments.noteId, input.noteId),
            isNull(comments.parentId),
            eq(comments.isResolved, false),
            whereWorkspace(notes, this.tenantContext),
          ),
        );

      // ORPHANED COMMENTS ARE NEVER FILTERED OUT, and orphan-ness is not a
      // server field: the API has no document positions to resolve `relFrom`
      // against, so any server flag would be a guess. The client holding the
      // live Y.Doc derives it while drawing the decoration.
      const items: CommentThread[] = visible.map((row) => {
        const own = replies.filter((reply) => reply.parentId === row.id);
        return Object.freeze({
          ...this.toSummary(row),
          replies: Object.freeze(own.map((reply) => this.toSummary(reply))),
        });
      });
      return Object.freeze({
        items: Object.freeze(items),
        page: input.page,
        limit: input.limit,
        hasMore: roots.length > input.limit,
        openCount: countRow?.count ?? 0,
      });
    });
  }

  async create(input: CreateCommentServiceInput): Promise<CommentMutationResult> {
    // `comment.create` is declared over a NOTE resource: the permission being
    // checked is "may this actor comment on this note" (`noteCanComment`).
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "comment.create",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const identity = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `comment.create:${input.workspaceId}:${input.noteId}`,
        key: input.idempotencyKey,
        payload: { content: input.content, parentId: input.parentId, anchor: input.anchor },
      });
      const row = await this.database.transaction(async (tx) => {
        await lockApiIdempotency(tx, identity);
        const replay = await loadApiIdempotency(tx, identity);
        if (replay !== null) {
          assertIdempotencyPayload(replay, identity);
          return this.readRow(tx, input.noteId, replay.resourceId);
        }
        await this.assertNoteInWorkspace(tx, input.noteId);
        const parentId = await this.resolveParent(tx, input.noteId, input.parentId);
        const commentId = randomUUID();
        await tx.insert(comments).values({
          id: commentId,
          noteId: input.noteId,
          parentId,
          content: input.content,
          createdById: input.principal.userId,
          // Stored verbatim. `anchor_key` NULL = a whole-note comment.
          //
          // ponytail: `anchor_from`/`anchor_to` are NEVER rewritten as the
          // document evolves, so a non-collaborative reader (print, export,
          // SSR preview) sees CREATION-TIME offsets and can land the highlight
          // in the wrong place on a heavily edited note. Upgrade path when that
          // bites: a debounced `PATCH .../comments/:id/anchor` from the client
          // that already resolved the relative position, or a periodic
          // server-side sweep that reprojects absolute offsets from the Y.Doc.
          anchorKey: input.anchor?.scheme ?? null,
          anchorFrom: input.anchor?.from ?? null,
          anchorTo: input.anchor?.to ?? null,
          anchorMetadata: this.toAnchorMetadata(input.anchor),
        });
        // Identifiers only — never `input.content`. Commits in the same
        // transaction as the insert above (ADR 0006).
        await recordAudit(tx, {
          workspaceId: activeWorkspaceId(this.tenantContext),
          userId: input.principal.userId,
          action: "comment.create",
          entityType: "comment",
          entityId: commentId,
          metadata: { noteId: input.noteId, parentId },
          requestId: input.requestId ?? null,
        });
        await storeApiIdempotency(tx, identity, commentId);
        return this.readRow(tx, input.noteId, commentId);
      });
      this.broadcast(input, row, "created");
      return Object.freeze({ comment: this.toSummary(row) });
    });
  }

  async update(input: UpdateCommentServiceInput): Promise<CommentMutationResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "comment.update",
      resource: { kind: "comment", id: input.commentId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(async (tx) => {
        // The scoped read IS the tenant proof: it joins `notes` and applies the
        // active workspace, so the following statements need only the
        // already-proven `(id, note_id)` pair.
        await this.readRow(tx, input.noteId, input.commentId);
        await tx
          .update(comments)
          .set({ content: input.content, updatedAt: new Date() })
          .where(and(eq(comments.id, input.commentId), eq(comments.noteId, input.noteId)));
        return this.readRow(tx, input.noteId, input.commentId);
      });
      this.broadcast(input, row, "updated");
      return Object.freeze({ comment: this.toSummary(row) });
    });
  }

  async remove(input: DeleteCommentServiceInput): Promise<CommentDeleteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "comment.delete",
      resource: { kind: "comment", id: input.commentId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const result = await this.database.transaction(async (tx) => {
        const row = await this.readRow(tx, input.noteId, input.commentId);
        // Read before delete: the `parent_id` self-FK cascades replies away, so
        // the count has to be taken while they still exist.
        const [replies] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(comments)
          .where(and(eq(comments.parentId, input.commentId), eq(comments.noteId, input.noteId)));
        const deletedCount = 1 + (replies?.count ?? 0);
        // Written BEFORE the delete, using the count already read above, so
        // the audit row never depends on a statement that could still roll
        // back the delete out from under it. Identifiers only.
        await recordAudit(tx, {
          workspaceId: activeWorkspaceId(this.tenantContext),
          userId: input.principal.userId,
          action: "comment.delete",
          entityType: "comment",
          entityId: input.commentId,
          metadata: { noteId: input.noteId, deletedCount },
          requestId: input.requestId ?? null,
        });
        await tx
          .delete(comments)
          .where(and(eq(comments.id, input.commentId), eq(comments.noteId, input.noteId)));
        return { row, deletedCount };
      });
      this.broadcast(input, result.row, "deleted");
      return Object.freeze({ id: result.row.id, deletedCount: result.deletedCount });
    });
  }

  /**
   * ONE method for both directions. Resolution is a property of the THREAD, so
   * a `commentId` naming a reply resolves that reply's root — a reply inherits
   * its thread's state and a half-resolved thread has no meaning in the UI.
   */
  async setResolution(input: SetCommentResolutionServiceInput): Promise<CommentMutationResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "comment.resolve",
      resource: { kind: "comment", id: input.commentId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(async (tx) => {
        const target = await this.readRow(tx, input.noteId, input.commentId);
        const rootId = target.parentId ?? target.id;
        await tx
          .update(comments)
          .set({
            isResolved: input.isResolved,
            // Unresolving clears BOTH stamps: a thread that was reopened has no
            // resolver and no resolution time, and leaving either behind would
            // render "Resolved by X" under an open thread.
            resolvedAt: input.isResolved ? new Date() : null,
            resolvedById: input.isResolved ? input.principal.userId : null,
            updatedAt: new Date(),
          })
          .where(and(eq(comments.id, rootId), eq(comments.noteId, input.noteId)));
        // `entityId` is the ROOT comment, not `input.commentId`: resolution is
        // a property of the THREAD (a reply inherits its root's state), so the
        // audited entity must be the same id the update above just wrote.
        // Identifiers only, committed in the same transaction (ADR 0006).
        await recordAudit(tx, {
          workspaceId: activeWorkspaceId(this.tenantContext),
          userId: input.principal.userId,
          action: input.isResolved ? "comment.resolve" : "comment.unresolve",
          entityType: "comment",
          entityId: rootId,
          metadata: { noteId: input.noteId },
          requestId: input.requestId ?? null,
        });
        return this.readRow(tx, input.noteId, rootId);
      });
      this.broadcast(input, row, input.isResolved ? "resolved" : "unresolved");
      return Object.freeze({ comment: this.toSummary(row) });
    });
  }

  /**
   * Fan the change out to the note room AFTER the transaction has committed —
   * never inside it, or a rolled-back write would still have told every viewer
   * to refetch.
   *
   * THE PAYLOAD IS IDENTIFIERS ONLY, deliberately:
   *   1. a content-carrying frame relayed from a client would let an author
   *      push arbitrary text into a room;
   *   2. content in a frame bypasses `comment.read` for anyone who joined the
   *      room earlier and has since lost permission;
   *   3. ADR 0004: "Socket.io event history is not document authority" — the
   *      id-only signal forces every client back through the authorized `GET`.
   *
   * `authorizeMessage` IS NOT NEEDED on this path. It guards CLIENT -> SERVER
   * frames, and Part 60 adds none: this is a one-way server -> room broadcast
   * raised from an already-authorized service call. Its absence is intentional,
   * not an omission.
   *
   * ponytail: not routed through the job outbox. This is ephemeral fan-out; a
   * dropped frame costs one stale sidebar until the next fetch or reconnect,
   * not lost data. Upgrade path if comment delivery ever needs an at-least-once
   * guarantee: emit a `comment.changed` outbox row and fan out from the worker.
   */
  private broadcast(
    scope: CommentScopedInput,
    row: CommentRow,
    kind: CommentChangedEvent["kind"],
  ): void {
    const payload: CommentChangedEvent = Object.freeze({
      // `noteId` is mandatory: one app-wide browser socket receives every joined
      // note's frames on the same handler (Socket.IO dispatches by event name,
      // not by room), so a frame without it is applied to the wrong note — the
      // cross-note corruption Part 58 fixed.
      noteId: scope.noteId,
      commentId: row.id,
      threadId: row.parentId ?? row.id,
      kind,
    });
    this.realtimeRooms.emit(
      { kind: "note", workspaceId: scope.workspaceId, noteId: scope.noteId },
      REALTIME_EVENTS.commentChanged,
      payload,
    );
  }

  private selectComments(runner: CommentQueryRunner) {
    return (
      runner
        .select({
          id: comments.id,
          noteId: comments.noteId,
          parentId: comments.parentId,
          content: comments.content,
          createdById: users.id,
          createdByName: users.name,
          isResolved: comments.isResolved,
          resolvedAt: comments.resolvedAt,
          resolvedById: resolvers.id,
          resolvedByName: resolvers.name,
          anchorKey: comments.anchorKey,
          anchorFrom: comments.anchorFrom,
          anchorTo: comments.anchorTo,
          anchorMetadata: comments.anchorMetadata,
          createdAt: comments.createdAt,
          updatedAt: comments.updatedAt,
        })
        .from(comments)
        // `comments` has no `workspace_id`; the join to `notes` IS the tenant
        // boundary and every caller adds `whereWorkspace(notes, ...)`.
        .innerJoin(notes, eq(notes.id, comments.noteId))
        .innerJoin(users, eq(users.id, comments.createdById))
        .leftJoin(resolvers, eq(resolvers.id, comments.resolvedById))
    );
  }

  private async readReplies(rootIds: readonly string[]): Promise<CommentRow[]> {
    if (rootIds.length === 0) return [];
    return this.selectComments(this.database.db)
      .where(
        and(inArray(comments.parentId, [...rootIds]), whereWorkspace(notes, this.tenantContext)),
      )
      .orderBy(asc(comments.createdAt), asc(comments.id));
  }

  /**
   * A comment id from another workspace misses this filter and 404s — never
   * 403, so a foreign id cannot be probed for existence.
   */
  private async readRow(
    runner: CommentQueryRunner,
    noteId: string,
    commentId: string,
  ): Promise<CommentRow> {
    const [row] = await this.selectComments(runner)
      .where(
        and(
          eq(comments.id, commentId),
          eq(comments.noteId, noteId),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }

  private async assertNoteInWorkspace(tx: DatabaseTransaction, noteId: string): Promise<void> {
    const [row] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .limit(1);
    if (row === undefined) this.notFound();
  }

  /**
   * A reply's parent must be a comment ON THE SAME NOTE; anything else is 404
   * (not 400, not 403) so a foreign parent id reveals nothing.
   *
   * REPLY-TO-A-REPLY IS RE-PARENTED TO THE THREAD ROOT rather than rejected:
   * threads stay two levels deep like every comment UI in this product's class,
   * and the client never has to explain a rejection the user did not cause.
   */
  private async resolveParent(
    tx: DatabaseTransaction,
    noteId: string,
    parentId: string | null,
  ): Promise<string | null> {
    if (parentId === null) return null;
    const parent = await this.readRow(tx, noteId, parentId);
    return parent.parentId ?? parent.id;
  }

  private toAnchorMetadata(anchor: CommentAnchor | null): Record<string, unknown> {
    if (anchor === null) return {};
    const metadata: Record<string, unknown> = {
      quote: anchor.quote,
      schemaVersion: anchor.schemaVersion,
    };
    if (anchor.relFrom !== undefined) metadata.relFrom = anchor.relFrom;
    if (anchor.relTo !== undefined) metadata.relTo = anchor.relTo;
    return metadata;
  }

  /**
   * Rebuild the anchor from its four columns and re-validate. A corrupt or
   * legacy row yields `anchor: null` (a whole-note comment) instead of a 500 —
   * one unreadable anchor must never make a thread unreadable.
   */
  private toAnchor(row: CommentRow): CommentAnchor | null {
    if (row.anchorKey === null) return null;
    const metadata = isRecord(row.anchorMetadata) ? row.anchorMetadata : {};
    const parsed = commentAnchorSchema.safeParse({
      scheme: row.anchorKey,
      from: row.anchorFrom,
      to: row.anchorTo,
      quote: metadata.quote,
      relFrom: metadata.relFrom,
      relTo: metadata.relTo,
      schemaVersion: metadata.schemaVersion,
    });
    return parsed.success ? Object.freeze(parsed.data) : null;
  }

  private toSummary(row: CommentRow): CommentSummary {
    return Object.freeze({
      id: row.id,
      noteId: row.noteId,
      parentId: row.parentId,
      content: row.content,
      createdBy: Object.freeze({ id: row.createdById, name: row.createdByName }),
      isResolved: row.isResolved,
      resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
      resolvedBy:
        row.resolvedById === null || row.resolvedByName === null
          ? null
          : Object.freeze({ id: row.resolvedById, name: row.resolvedByName }),
      anchor: this.toAnchor(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
