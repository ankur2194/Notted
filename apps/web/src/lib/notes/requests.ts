import { COMMENT_API_PATHS, MEMBERSHIP_API_PATHS, NOTE_API_PATHS } from "@notted/shared-types";
import {
  commentDeleteResultSchema,
  commentListQuerySchema,
  commentMutationResultSchema,
  commentPageSchema,
  commentResolutionSchema,
  copyNoteSchema,
  createCommentSchema,
  createFolderSchema,
  createNoteSchema,
  deleteFolderSchema,
  deleteNoteSchema,
  folderCreateResultSchema,
  folderDeleteResultSchema,
  folderPageSchema,
  folderUpdateResultSchema,
  moveNoteSchema,
  noteCreateResultSchema,
  noteDeleteResultSchema,
  noteListQuerySchema,
  noteMoveResultSchema,
  notePageSchema,
  notePermanentDeleteResultSchema,
  noteRestoreResultSchema,
  noteShareDeleteResultSchema,
  noteShareListSchema,
  noteShareUpsertResultSchema,
  noteUpdateResultSchema,
  noteVersionDetailSchema,
  noteVersionListQuerySchema,
  noteVersionPageSchema,
  noteVersionRestoreResultSchema,
  permanentDeleteNoteSchema,
  restoreNoteSchema,
  restoreNoteVersionSchema,
  updateCommentSchema,
  updateFolderSchema,
  updateNoteSchema,
  upsertNoteShareSchema,
  workspaceMemberPageSchema,
} from "@notted/shared-validators";

import type { NoteRequestOptions, NoteRequestResult } from "@/lib/api/request-json";
import type {
  CommentDeleteResult,
  CommentMutationResult,
  CommentPage,
  FolderCreateResult,
  FolderDeleteResult,
  FolderPage,
  FolderUpdateResult,
  NoteCreateResult,
  NoteDeleteResult,
  NoteListQuery,
  NoteMoveResult,
  NotePage,
  NotePermanentDeleteResult,
  NoteRestoreResult,
  NoteShareDeleteResult,
  NoteShareList,
  NoteShareUpsertResult,
  NoteUpdateResult,
  NoteVersionDetail,
  NoteVersionPage,
  NoteVersionRestoreResult,
  WorkspaceMemberPage,
} from "@notted/shared-types";
import type {
  CommentListQueryInput,
  CommentResolutionInput,
  CopyNoteInput,
  CreateCommentInput,
  CreateFolderInput,
  CreateNoteInput,
  DeleteNoteInput,
  MoveNoteInput,
  PermanentDeleteNoteInput,
  RestoreNoteInput,
  UpdateCommentInput,
  UpdateFolderInput,
  UpdateNoteInput,
  RestoreNoteVersionInput,
  UpsertNoteShareInput,
} from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

/**
 * The transport moved to `@/lib/api/request-json` when tags and templates
 * needed the identical envelope. The names stay reachable from here so no note
 * import had to change; new modules should import them from the API module.
 */
export { KEEPALIVE_BODY_LIMIT_BYTES } from "@/lib/api/request-json";
export type {
  NoteRequestFailure,
  NoteRequestFailureKind,
  NoteRequestOptions,
  NoteRequestResult,
} from "@/lib/api/request-json";

function listSearch(query: NoteListQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    scope: query.scope,
    view: query.view,
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  });
  if (query.projectId !== undefined) params.set("projectId", query.projectId);
  if (query.folderId !== undefined && query.folderId !== null)
    params.set("folderId", query.folderId);
  if (query.type !== undefined) params.set("type", query.type);
  if (query.tagId !== undefined) params.set("tagId", query.tagId);
  if (query.isArchived !== undefined) params.set("isArchived", String(query.isArchived));
  return params.toString();
}

/**
 * Restates an already-parsed `NoteListQuery` in the query-string shape
 * `noteListQuerySchema` accepts as input.
 *
 * Callers hold the schema's *output* — `parseNoteSearchParams` returns it, and
 * the page components pass it straight through — where the explicit boolean
 * selectors are real booleans and the optional id selectors may be `null`. The
 * schema's *input* is the raw URL form: `"true"`/`"false"` strings, and absent
 * rather than null. Re-validating the output against the input contract without
 * this step rejects every query that uses one of those selectors, so a view
 * like archived notes would fail closed and render empty while never issuing a
 * request.
 */
function listQueryInput(query: NoteListQuery): Record<string, unknown> {
  const asQueryString = (value: boolean | undefined): string | undefined =>
    value === undefined ? undefined : String(value);
  return {
    ...query,
    folderId: query.folderId ?? undefined,
    parentId: query.parentId ?? undefined,
    rootFolder: asQueryString(query.rootFolder),
    rootParent: asQueryString(query.rootParent),
    isTemplate: asQueryString(query.isTemplate),
    isPinned: asQueryString(query.isPinned),
    isArchived: asQueryString(query.isArchived),
  };
}

export function requestNotePage(
  workspaceId: string,
  query: NoteListQuery,
): Promise<NoteRequestResult<NotePage>> {
  const parsed = noteListQuerySchema.safeParse(listQueryInput(query));
  if (!validIds(workspaceId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    `${NOTE_API_PATHS.collection(workspaceId)}?${listSearch(parsed.data)}`,
    {},
    (value) => notePageSchema.safeParse(value),
  );
}

export function createNote(
  workspaceId: string,
  input: CreateNoteInput,
  idempotencyKey: string,
): Promise<NoteRequestResult<NoteCreateResult>> {
  const parsed = createNoteSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    NOTE_API_PATHS.collection(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => noteCreateResultSchema.safeParse(value),
  );
}

/**
 * Template copying in both directions: `asTemplate: true` saves an ordinary
 * note as a template, `asTemplate: false` on a template row instantiates it.
 * The copy is by value — the contract carries no source reference, so there is
 * nothing here that could create a live link back to the original.
 */
export function copyNote(
  workspaceId: string,
  noteId: string,
  input: CopyNoteInput,
  idempotencyKey: string,
): Promise<NoteRequestResult<NoteCreateResult>> {
  const parsed = copyNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    NOTE_API_PATHS.copy(workspaceId, noteId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => noteCreateResultSchema.safeParse(value),
  );
}

export function updateNote(
  workspaceId: string,
  noteId: string,
  input: UpdateNoteInput,
  options: NoteRequestOptions = {},
): Promise<NoteRequestResult<NoteUpdateResult>> {
  const parsed = updateNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.detail(workspaceId, noteId),
    json("PATCH", parsed.data),
    (value) => noteUpdateResultSchema.safeParse(value),
    options,
  );
}

export function requestNoteVersions(
  workspaceId: string,
  noteId: string,
  input: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<NoteRequestResult<NoteVersionPage>> {
  const parsed = noteVersionListQuerySchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  const query = new URLSearchParams({ limit: String(parsed.data.limit) });
  if (parsed.data.cursor !== undefined) query.set("cursor", parsed.data.cursor);
  return requestJson(
    `${NOTE_API_PATHS.versions(workspaceId, noteId)}?${query.toString()}`,
    {},
    (value) => noteVersionPageSchema.safeParse(value),
  );
}

export function requestNoteVersion(
  workspaceId: string,
  noteId: string,
  versionId: string,
): Promise<NoteRequestResult<NoteVersionDetail>> {
  if (!validIds(workspaceId, noteId, versionId))
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.version(workspaceId, noteId, versionId), {}, (value) =>
    noteVersionDetailSchema.safeParse(value),
  );
}

export function restoreNoteVersion(
  workspaceId: string,
  noteId: string,
  versionId: string,
  input: RestoreNoteVersionInput,
): Promise<NoteRequestResult<NoteVersionRestoreResult>> {
  const parsed = restoreNoteVersionSchema.safeParse(input);
  if (!validIds(workspaceId, noteId, versionId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.restoreVersion(workspaceId, noteId, versionId),
    json("POST", parsed.data),
    (value) => noteVersionRestoreResultSchema.safeParse(value),
  );
}

export function moveNote(
  workspaceId: string,
  noteId: string,
  input: MoveNoteInput,
): Promise<NoteRequestResult<NoteMoveResult>> {
  const parsed = moveNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.move(workspaceId, noteId), json("POST", parsed.data), (value) =>
    noteMoveResultSchema.safeParse(value),
  );
}

export function trashNote(
  workspaceId: string,
  noteId: string,
  input: DeleteNoteInput,
): Promise<NoteRequestResult<NoteDeleteResult>> {
  const parsed = deleteNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.detail(workspaceId, noteId),
    json("DELETE", parsed.data),
    (value) => noteDeleteResultSchema.safeParse(value),
  );
}

export function restoreNote(
  workspaceId: string,
  noteId: string,
  input: RestoreNoteInput,
): Promise<NoteRequestResult<NoteRestoreResult>> {
  const parsed = restoreNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.restore(workspaceId, noteId),
    json("POST", parsed.data),
    (value) => noteRestoreResultSchema.safeParse(value),
  );
}

export function permanentlyDeleteNote(
  workspaceId: string,
  noteId: string,
  input: PermanentDeleteNoteInput,
): Promise<NoteRequestResult<NotePermanentDeleteResult>> {
  const parsed = permanentDeleteNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.permanentDelete(workspaceId, noteId),
    json("POST", parsed.data),
    (value) => notePermanentDeleteResultSchema.safeParse(value),
  );
}

export function requestFolders(workspaceId: string): Promise<NoteRequestResult<FolderPage>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(`${NOTE_API_PATHS.folders(workspaceId)}?page=1&limit=100`, {}, (value) =>
    folderPageSchema.safeParse(value),
  );
}

export function createFolder(
  workspaceId: string,
  input: CreateFolderInput,
): Promise<NoteRequestResult<FolderCreateResult>> {
  const parsed = createFolderSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.folders(workspaceId), json("POST", parsed.data), (value) =>
    folderCreateResultSchema.safeParse(value),
  );
}

export function updateFolder(
  workspaceId: string,
  folderId: string,
  input: UpdateFolderInput,
): Promise<NoteRequestResult<FolderUpdateResult>> {
  const parsed = updateFolderSchema.safeParse(input);
  if (!validIds(workspaceId, folderId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.folder(workspaceId, folderId),
    json("PATCH", parsed.data),
    (value) => folderUpdateResultSchema.safeParse(value),
  );
}

export function deleteFolder(
  workspaceId: string,
  folderId: string,
): Promise<NoteRequestResult<FolderDeleteResult>> {
  const body = deleteFolderSchema.parse({ confirm: true });
  if (!validIds(workspaceId, folderId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.folder(workspaceId, folderId), json("DELETE", body), (value) =>
    folderDeleteResultSchema.safeParse(value),
  );
}

/** Largest page the member listing contract allows (`workspaceMemberPageSchema`). */
export const WORKSPACE_MEMBER_PAGE_SIZE = 100;

/**
 * How many member pages a client may request before it stops.
 *
 * A bound is required: without one an unexpectedly long listing would turn one
 * UI interaction into an unbounded request loop. Ten pages covers every
 * workspace the product targets; beyond it the client reports truncation
 * honestly rather than pretending the extra members do not exist.
 */
export const WORKSPACE_MEMBER_MAX_PAGES = 10;

/** Largest number of members any client-side member directory will hold. */
export const WORKSPACE_MEMBER_DIRECTORY_LIMIT =
  WORKSPACE_MEMBER_PAGE_SIZE * WORKSPACE_MEMBER_MAX_PAGES;

export function requestWorkspaceMembers(
  workspaceId: string,
  page = 1,
): Promise<NoteRequestResult<WorkspaceMemberPage>> {
  if (!validIds(workspaceId) || !Number.isInteger(page) || page < 1) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  const path = MEMBERSHIP_API_PATHS.members.replace(
    ":workspaceId",
    encodeURIComponent(workspaceId),
  );
  return requestJson(`${path}?page=${page}&limit=${WORKSPACE_MEMBER_PAGE_SIZE}`, {}, (value) =>
    workspaceMemberPageSchema.safeParse(value),
  );
}

/**
 * Every authorized member of one workspace, as a single page-shaped result.
 *
 * The member listing has no server-side name filter, so any client that has to
 * match members locally — the mention menu, the share dialog — needs the whole
 * list rather than its first page. Pages are fetched in order until the server
 * reports no more, or until `WORKSPACE_MEMBER_MAX_PAGES` is reached. The
 * returned `hasMore` means exactly "this client stopped before the server ran
 * out", so callers can say so instead of implying the missing people are not
 * members. A failed page fails the whole request: a partial directory that
 * claims to be complete is worse than an error state.
 */
export async function requestAllWorkspaceMembers(
  workspaceId: string,
): Promise<NoteRequestResult<WorkspaceMemberPage>> {
  const items: WorkspaceMemberPage["items"][number][] = [];
  let hasMore = false;

  for (let page = 1; page <= WORKSPACE_MEMBER_MAX_PAGES; page += 1) {
    const result = await requestWorkspaceMembers(workspaceId, page);
    if (!result.ok) return result;
    items.push(...result.data.items);
    hasMore = result.data.hasMore;
    if (!hasMore) break;
  }

  return {
    ok: true,
    data: { items, page: 1, limit: WORKSPACE_MEMBER_DIRECTORY_LIMIT, hasMore },
  };
}

export function requestNoteShares(
  workspaceId: string,
  noteId: string,
): Promise<NoteRequestResult<NoteShareList>> {
  if (!validIds(workspaceId, noteId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.shares(workspaceId, noteId), {}, (value) =>
    noteShareListSchema.safeParse(value),
  );
}

export function upsertNoteShare(
  workspaceId: string,
  noteId: string,
  userId: string,
  input: UpsertNoteShareInput,
): Promise<NoteRequestResult<NoteShareUpsertResult>> {
  const parsed = upsertNoteShareSchema.safeParse(input);
  if (!validIds(workspaceId, noteId, userId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.share(workspaceId, noteId, userId),
    json("PUT", parsed.data),
    (value) => noteShareUpsertResultSchema.safeParse(value),
  );
}

export function revokeNoteShare(
  workspaceId: string,
  noteId: string,
  userId: string,
): Promise<NoteRequestResult<NoteShareDeleteResult>> {
  if (!validIds(workspaceId, noteId, userId))
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.share(workspaceId, noteId, userId),
    { method: "DELETE" },
    (value) => noteShareDeleteResultSchema.safeParse(value),
  );
}

/* ------------------------------------------------------------------------- *
 * Inline comments (Part 60)
 *
 * Identical envelope to every request above: `requestJson` supplies
 * `credentials: "include"`, `cache: "no-store"` and the 8s abort, the browser
 * supplies `Origin` on every cross-origin mutation (nothing here sets it by
 * hand — a header a script can write is not a CSRF signal), and every response
 * is validated against the shared Zod contract before a component sees it.
 * ------------------------------------------------------------------------- */

export function requestNoteComments(
  workspaceId: string,
  noteId: string,
  input: CommentListQueryInput = {},
): Promise<NoteRequestResult<CommentPage>> {
  const parsed = commentListQuerySchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  const query = new URLSearchParams({
    page: String(parsed.data.page),
    limit: String(parsed.data.limit),
    status: parsed.data.status,
  });
  return requestJson(
    `${COMMENT_API_PATHS.collection(workspaceId, noteId)}?${query.toString()}`,
    {},
    (value) => commentPageSchema.safeParse(value),
  );
}

export function createNoteComment(
  workspaceId: string,
  noteId: string,
  input: CreateCommentInput,
  idempotencyKey: string,
): Promise<NoteRequestResult<CommentMutationResult>> {
  const parsed = createCommentSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    COMMENT_API_PATHS.collection(workspaceId, noteId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => commentMutationResultSchema.safeParse(value),
  );
}

export function updateNoteComment(
  workspaceId: string,
  noteId: string,
  commentId: string,
  input: UpdateCommentInput,
): Promise<NoteRequestResult<CommentMutationResult>> {
  const parsed = updateCommentSchema.safeParse(input);
  if (!validIds(workspaceId, noteId, commentId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    COMMENT_API_PATHS.detail(workspaceId, noteId, commentId),
    json("PATCH", parsed.data),
    (value) => commentMutationResultSchema.safeParse(value),
  );
}

export function deleteNoteComment(
  workspaceId: string,
  noteId: string,
  commentId: string,
): Promise<NoteRequestResult<CommentDeleteResult>> {
  if (!validIds(workspaceId, noteId, commentId))
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    COMMENT_API_PATHS.detail(workspaceId, noteId, commentId),
    { method: "DELETE" },
    (value) => commentDeleteResultSchema.safeParse(value),
  );
}

/**
 * One idempotent transition, not two routes. The server applies it to the
 * THREAD ROOT: resolving a reply resolves the thread it belongs to, which is
 * why the UI only ever offers the control on a root comment.
 */
export function setNoteCommentResolution(
  workspaceId: string,
  noteId: string,
  commentId: string,
  input: CommentResolutionInput,
): Promise<NoteRequestResult<CommentMutationResult>> {
  const parsed = commentResolutionSchema.safeParse(input);
  if (!validIds(workspaceId, noteId, commentId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    COMMENT_API_PATHS.resolution(workspaceId, noteId, commentId),
    json("POST", parsed.data),
    (value) => commentMutationResultSchema.safeParse(value),
  );
}
