import { MEMBERSHIP_API_PATHS, NOTE_API_PATHS } from "@notted/shared-types";
import {
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
  permanentDeleteNoteSchema,
  restoreNoteSchema,
  updateFolderSchema,
  updateNoteSchema,
  upsertNoteShareSchema,
  uuidSchema,
  workspaceMemberPageSchema,
} from "@notted/shared-validators";

import type {
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
  WorkspaceMemberPage,
} from "@notted/shared-types";
import type {
  CreateFolderInput,
  CreateNoteInput,
  DeleteNoteInput,
  MoveNoteInput,
  PermanentDeleteNoteInput,
  RestoreNoteInput,
  UpdateFolderInput,
  UpdateNoteInput,
  UpsertNoteShareInput,
} from "@notted/shared-validators";

import { publicEnvironment } from "@/config/public-environment";

export type NoteRequestFailureKind =
  "invalid" | "forbidden-or-not-found" | "version-conflict" | "conflict" | "unavailable";

/**
 * A failed request.
 *
 * `kind` is the stable vocabulary every note surface writes its own copy from;
 * it is deliberately *not* widened, because eight components already switch on
 * exactly these five values.
 *
 * The two optional fields exist for Part 39's autosave, which has to tell a
 * retryable outage apart from a permanent rejection — `unavailable` covers both
 * a 503 and an unsupported method. Every other caller simply ignores them.
 */
export interface NoteRequestFailure {
  readonly ok: false;
  readonly kind: NoteRequestFailureKind;
  /** True only when repeating the identical request could plausibly succeed. */
  readonly retryable?: boolean;
  /** Server-advised wait before repeating it, parsed from `Retry-After`. */
  readonly retryAfterMs?: number;
}

export type NoteRequestResult<T> = { readonly ok: true; readonly data: T } | NoteRequestFailure;

type SafeParser<T> = (value: unknown) => { success: true; data: T } | { success: false };

/**
 * Largest body the fetch specification allows on a `keepalive` request.
 *
 * A keepalive request whose body exceeds this is rejected as a network error
 * before it leaves the browser, so a navigation flush of a large note must fall
 * back to an ordinary request rather than silently vanish.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 64 * 1024;

export interface NoteRequestOptions {
  /**
   * Ask the browser to keep this request alive across a navigation or a hidden
   * document. Ignored when the body is larger than the specification's 64 KiB
   * keepalive limit, since a rejected request saves nothing at all.
   */
  readonly keepalive?: boolean;
}

function bodyFitsKeepalive(body: BodyInit | null | undefined): boolean {
  if (typeof body !== "string") return false;
  return new TextEncoder().encode(body).length <= KEEPALIVE_BODY_LIMIT_BYTES;
}

/**
 * `Retry-After` as milliseconds. The header is delta-seconds or an HTTP date;
 * both are accepted, anything else is treated as absent so a malformed header
 * can never stall a client indefinitely.
 */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds, 300) * 1_000 : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), 300_000);
}

async function conflictKind(response: Response): Promise<"version-conflict" | "conflict"> {
  try {
    const body: unknown = await response.json();
    const topCode =
      typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    const nested =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    const nestedCode =
      typeof nested === "object" && nested !== null && "code" in nested ? nested.code : undefined;
    if (topCode === "VERSION_CONFLICT" || nestedCode === "VERSION_CONFLICT") {
      return "version-conflict";
    }
  } catch {
    // The status remains a safe generic conflict when the error envelope is unavailable.
  }
  return "conflict";
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  parser: SafeParser<T>,
  options: NoteRequestOptions = {},
): Promise<NoteRequestResult<T>> {
  // A keepalive request has to outlive the document that started it, so it gets
  // no abort timer: a timeout scheduled on a page that is going away either
  // never fires or cancels the very request the flush exists to deliver.
  const keepalive = options.keepalive === true && bodyFitsKeepalive(init.body);
  try {
    const response = await fetch(new URL(path, publicEnvironment.NEXT_PUBLIC_API_URL), {
      ...init,
      cache: "no-store",
      credentials: "include",
      ...(keepalive ? { keepalive: true } : { signal: AbortSignal.timeout(8_000) }),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) return { ok: false, kind: "invalid" };
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { ok: false, kind: "forbidden-or-not-found" };
      }
      if (response.status === 409) return { ok: false, kind: await conflictKind(response) };
      // Only a rate limit or a server fault is worth repeating unchanged. Every
      // other status (405, 413, 415, …) describes the request itself and would
      // fail identically forever.
      return {
        ok: false,
        kind: "unavailable",
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: retryAfterMs(response),
      };
    }
    const parsed = parser(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    // Offline, DNS failure, TLS failure, or the 8s timeout above: all transient
    // by nature, so the caller is allowed to repeat them.
    return { ok: false, kind: "unavailable", retryable: true };
  }
}

function validIds(...ids: readonly string[]): boolean {
  return ids.every((id) => uuidSchema.safeParse(id).success);
}

function json(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

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
