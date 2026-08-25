// Part 60 — pure unit tests for CommentsService. No database, no Nest container:
// the collaborators are hand-stubbed and the Drizzle builder is a chainable fake
// that hands back a queued result per `select`, which is enough to pin the four
// behaviours that are genuinely easy to regress.

import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { auditLogs } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { CommentsService } from "./comments.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { RealtimeRoomService } from "../realtime/realtime-room.service";
import type { AuthenticatedPrincipal, CommentAnchor } from "@notted/shared-types";

const workspaceId = "50000000-0000-4000-8000-000000000001";
const noteId = "50000000-0000-4000-8000-000000000002";
const commentId = "50000000-0000-4000-8000-000000000004";
const parentId = "50000000-0000-4000-8000-000000000005";
const userId = "50000000-0000-4000-8000-000000000006";

const principal = {
  userId,
  sessionId: "50000000-0000-4000-8000-000000000007",
  assurance: "single-factor",
  authenticatedAt: null,
  expiresAt: null,
  isFresh: true,
} as unknown as AuthenticatedPrincipal;

const anchor: CommentAnchor = Object.freeze({
  scheme: "yrel:1",
  from: 12,
  to: 34,
  quote: "the anchored sentence",
  relFrom: "AQIDBAU",
  relTo: "BQQDAgE",
  schemaVersion: 1,
});

type Row = Record<string, unknown>;

function commentRow(overrides: Row = {}): Row {
  return {
    id: commentId,
    noteId,
    parentId: null,
    content: "Looks good to me",
    createdById: userId,
    createdByName: "Ana Editor",
    isResolved: false,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    anchorKey: null,
    anchorFrom: null,
    anchorTo: null,
    anchorMetadata: {},
    createdAt: new Date("2026-08-14T10:00:00.000Z"),
    updatedAt: new Date("2026-08-14T10:00:00.000Z"),
    ...overrides,
  };
}

const CHAIN_METHODS = [
  "from",
  "innerJoin",
  "leftJoin",
  "where",
  "orderBy",
  "limit",
  "offset",
  "values",
  "set",
  "returning",
] as const;

function harness(selects: Row[][] = []) {
  const queue = [...selects];
  const inserts: { table: unknown; values: Row }[] = [];
  const updates: { table: unknown; values: Row }[] = [];
  const deletes: unknown[] = [];
  /** Flipped by the fake `transaction` wrapper the moment the callback resolves. */
  const state = { committed: false };
  const emitOrder: boolean[] = [];

  const chain = (resolve: () => unknown): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) node[method] = () => node;
    node.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled);
    return node;
  };

  const runner = {
    select: () => chain(() => queue.shift() ?? []),
    execute: vi.fn().mockResolvedValue(undefined),
    insert: (table: unknown) => {
      const node = chain(() => []);
      node.values = (values: Row) => {
        inserts.push({ table, values });
        return node;
      };
      return node;
    },
    update: (table: unknown) => {
      const node = chain(() => []);
      node.set = (values: Row) => {
        updates.push({ table, values });
        return node;
      };
      return node;
    },
    delete: (table: unknown) => {
      deletes.push(table);
      return chain(() => []);
    },
  };

  const database = {
    db: runner,
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const result = await work(runner);
      state.committed = true;
      return result;
    },
  } as unknown as DatabaseService;

  const tenantContext = new TenantContextService();
  const authorizationEntry = {
    authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId }),
    run: <T>(_operation: unknown, work: () => T): T =>
      tenantContext.run(createTenantContext({ workspaceId, userId }), work),
  } as unknown as AuthorizationEntryService;

  const emit = vi.fn(() => {
    emitOrder.push(state.committed);
  });
  const realtimeRooms = { emit } as unknown as RealtimeRoomService;

  const subject = new CommentsService(database, authorizationEntry, tenantContext, realtimeRooms);
  return { subject, inserts, updates, deletes, emit, emitOrder, state };
}

const scope = { principal, workspaceId, noteId, requestId: null };

describe("CommentsService.create", () => {
  it("rejects a reply whose parent belongs to a different note", async () => {
    // The parent lookup is scoped by BOTH note id and workspace, so a parent on
    // `otherNoteId` simply misses — the service must surface that as 404, never
    // 400 or 403, so a foreign comment id cannot be probed for existence.
    const { subject, inserts } = harness([
      [], // no idempotency replay
      [{ id: noteId }], // note exists in the active workspace
      [], // parent lookup misses: it lives on another note
    ]);

    const failure = await subject
      .create({
        ...scope,
        content: "reply",
        parentId,
        anchor: null,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiHttpException);
    expect((failure as ApiHttpException).getStatus()).toBe(404);
    expect((failure as ApiHttpException).safeResponse.code).toBe("NOT_FOUND");
    expect(inserts).toHaveLength(0);
  });

  it("stores the anchor exactly as sent and echoes it back unmodified", async () => {
    const stored = commentRow({
      anchorKey: anchor.scheme,
      anchorFrom: anchor.from,
      anchorTo: anchor.to,
      anchorMetadata: {
        quote: anchor.quote,
        relFrom: anchor.relFrom,
        relTo: anchor.relTo,
        schemaVersion: anchor.schemaVersion,
      },
    });
    const { subject, inserts } = harness([
      [], // no idempotency replay
      [{ id: noteId }], // note exists
      [stored], // read-back
    ]);

    const result = await subject.create({
      ...scope,
      content: "Anchored note",
      parentId: null,
      anchor,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });

    const written = inserts.at(0)?.values;
    expect(written).toMatchObject({
      anchorKey: "yrel:1",
      anchorFrom: 12,
      anchorTo: 34,
      anchorMetadata: {
        quote: anchor.quote,
        relFrom: anchor.relFrom,
        relTo: anchor.relTo,
        schemaVersion: anchor.schemaVersion,
      },
    });
    // The server never remaps: what came in is what goes back out.
    expect(result.comment.anchor).toEqual(anchor);
  });

  it("broadcasts only after the transaction has resolved", async () => {
    const { subject, emit, emitOrder } = harness([[], [{ id: noteId }], [commentRow()]]);

    await subject.create({
      ...scope,
      content: "hello",
      parentId: null,
      anchor: null,
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    // `true` means the transaction wrapper had already marked the work
    // committed when the emit ran — a broadcast inside the callback would
    // record `false` here.
    expect(emitOrder).toEqual([true]);
    expect(emit).toHaveBeenCalledWith(
      { kind: "note", workspaceId, noteId },
      "realtime:comment:changed",
      { noteId, commentId, threadId: commentId, kind: "created" },
    );
  });
});

describe("CommentsService.setResolution", () => {
  it("stamps resolved_at and resolved_by_id when resolving", async () => {
    const { subject, updates, inserts, emit } = harness([
      [commentRow()], // the target thread root
      [
        commentRow({
          isResolved: true,
          resolvedAt: new Date("2026-08-14T11:00:00.000Z"),
          resolvedById: userId,
          resolvedByName: "Ana Editor",
        }),
      ],
    ]);

    const result = await subject.setResolution({ ...scope, commentId, isResolved: true });

    const written = updates.at(0)?.values;
    expect(written?.isResolved).toBe(true);
    expect(written?.resolvedAt).toBeInstanceOf(Date);
    expect(written?.resolvedById).toBe(userId);
    expect(result.comment.resolvedBy).toEqual({ id: userId, name: "Ana Editor" });
    expect(result.comment.resolvedAt).toBe("2026-08-14T11:00:00.000Z");
    // Identifiers only — never the comment body.
    const audit = inserts.find((entry) => entry.table === auditLogs);
    expect(audit?.values).toMatchObject({
      workspaceId,
      userId,
      action: "comment.resolve",
      entityType: "comment",
      entityId: commentId,
      metadata: { noteId },
    });
    expect(emit).toHaveBeenCalledWith(expect.anything(), "realtime:comment:changed", {
      noteId,
      commentId,
      threadId: commentId,
      kind: "resolved",
    });
  });

  it("clears BOTH resolution stamps when unresolving", async () => {
    const { subject, updates, emitOrder } = harness([
      [
        commentRow({
          isResolved: true,
          resolvedAt: new Date("2026-08-14T11:00:00.000Z"),
          resolvedById: userId,
          resolvedByName: "Ana Editor",
        }),
      ],
      [commentRow()],
    ]);

    const result = await subject.setResolution({ ...scope, commentId, isResolved: false });

    const written = updates.at(0)?.values;
    expect(written?.isResolved).toBe(false);
    expect(written?.resolvedAt).toBeNull();
    expect(written?.resolvedById).toBeNull();
    expect(result.comment.resolvedAt).toBeNull();
    expect(result.comment.resolvedBy).toBeNull();
    expect(emitOrder).toEqual([true]);
  });

  it("resolves the thread root when the id names a reply", async () => {
    const { subject, updates } = harness([
      [commentRow({ id: "50000000-0000-4000-8000-000000000008", parentId })], // a reply
      [commentRow({ id: parentId, isResolved: true, resolvedById: userId, resolvedByName: "Ana" })],
    ]);

    const result = await subject.setResolution({
      ...scope,
      commentId: "50000000-0000-4000-8000-000000000008",
      isResolved: true,
    });

    expect(updates).toHaveLength(1);
    expect(result.comment.id).toBe(parentId);
  });
});

describe("CommentsService.update", () => {
  it("404s a comment id that is not on this note in this workspace", async () => {
    const { subject } = harness([[]]);
    await expect(subject.update({ ...scope, commentId, content: "edited" })).rejects.toBeInstanceOf(
      ApiHttpException,
    );
  });
});
