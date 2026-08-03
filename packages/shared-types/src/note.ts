import type {
  FolderId,
  IsoTimestamp,
  JsonValue,
  NoteId,
  ProjectId,
  TagId,
  UserId,
  WorkspaceId,
} from "./common";

export const NOTE_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/notes`,
  detail: (workspaceId: string, noteId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
  move: (workspaceId: string, noteId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/move`,
  restore: (workspaceId: string, noteId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/restore`,
  permanentDelete: (workspaceId: string, noteId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/permanent-delete`,
  navigation: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/notes/navigation`,
  folders: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/folders`,
  folder: (workspaceId: string, folderId: string) =>
    `/api/v1/workspaces/${workspaceId}/folders/${folderId}`,
  shares: (workspaceId: string, noteId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/shares`,
  share: (workspaceId: string, noteId: string, userId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/shares/${userId}`,
} as const);

export type NoteType = "document" | "task-list";
export type PageSize = "a4" | "letter";
export type NoteLocation = "workspace-root" | "project";
export type NoteListView = "normal" | "recent" | "pinned" | "templates" | "trash";
export type NoteSortField = "title" | "createdAt" | "updatedAt" | "deletedAt" | "sortOrder";
export type NoteSharePermission = "view" | "comment" | "edit";
export type NoteShareMutationPermission = "view" | "edit";

/**
 * Final TipTap document contract rooted at `{ type: "doc" }`. The allowed
 * node types, mark types, attribute rules, size bounds, schema version, link
 * sanitization, plain-text extraction, HTML rendering, and migration policy
 * are owned by `@notted/shared-validators` (see `NOTE_DOCUMENT_NODE_TYPES`,
 * `NOTE_DOCUMENT_MARK_TYPES`, `NOTE_DOCUMENT_LIMITS`,
 * `NOTE_DOCUMENT_CODE_LANGUAGES`, `NOTE_DOCUMENT_SCHEMA_VERSION`,
 * `noteDocumentMentionAttrs`, `safeParseNoteDocument`, and
 * `migrateNoteDocument`). A `mention` node persists a stable UUID user id plus
 * a bounded display-name snapshot; the snapshot is untrusted display data and
 * is escaped everywhere it is rendered. This interface is the framework-neutral
 * projection shared across the API and web boundaries.
 */
export interface NoteDocument {
  readonly type: "doc";
  readonly [key: string]: JsonValue;
}

export interface NoteSummary {
  readonly id: NoteId;
  readonly workspaceId: WorkspaceId;
  readonly location: NoteLocation;
  readonly projectId: ProjectId | null;
  readonly folderId: FolderId | null;
  readonly parentId: NoteId | null;
  readonly title: string;
  readonly type: NoteType;
  readonly pageSize: PageSize;
  readonly sortOrder: number;
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly isDeleted: boolean;
  readonly tagIds: readonly TagId[];
  readonly version: number;
  readonly deletedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface NoteDetail extends NoteSummary {
  readonly content: NoteDocument;
  readonly contentPlain: string;
  readonly createdById: UserId;
  readonly updatedById: UserId | null;
  readonly currentActorId: UserId;
  readonly capabilities: NoteCapabilities;
}

export interface NoteCapabilities {
  readonly canUpdate: boolean;
  readonly canDelete: boolean;
  readonly canShare: boolean;
}

export interface NotePage {
  readonly items: readonly NoteSummary[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface NoteNavigationItem {
  readonly id: NoteId;
  readonly projectId: ProjectId | null;
  readonly folderId: FolderId | null;
  readonly parentId: NoteId | null;
  readonly title: string;
  readonly type: NoteType;
  readonly sortOrder: number;
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly version: number;
  readonly updatedAt: IsoTimestamp;
}

export interface NoteNavigation {
  readonly items: readonly NoteNavigationItem[];
  readonly limit: number;
  readonly returned: number;
  readonly truncated: boolean;
}

export interface NoteCreateResult {
  readonly note: NoteDetail;
}

export interface NoteUpdateResult {
  readonly note: NoteDetail;
}

export interface NoteMoveResult {
  readonly note: NoteSummary;
}

export interface NoteDeleteResult {
  readonly id: NoteId;
  readonly deleted: true;
  readonly affected: number;
  readonly version: number;
  readonly deletedAt: IsoTimestamp;
}

export interface NoteRestoreResult {
  readonly id: NoteId;
  readonly restored: true;
  readonly affected: number;
  readonly version: number;
}

export interface NotePermanentDeleteResult {
  readonly id: NoteId;
  readonly permanentlyDeleted: true;
}

export interface FolderSummary {
  readonly id: FolderId;
  readonly workspaceId: WorkspaceId;
  readonly parentId: FolderId | null;
  readonly name: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface FolderPage {
  readonly items: readonly FolderSummary[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface FolderCreateResult {
  readonly folder: FolderSummary;
}

export interface FolderUpdateResult {
  readonly folder: FolderSummary;
}

export interface FolderDeleteResult {
  readonly id: FolderId;
  readonly deleted: true;
  readonly removedFolders: number;
  readonly unfiledNotes: number;
}

export interface NoteShareGrant {
  readonly id: string;
  readonly noteId: NoteId;
  readonly userId: UserId;
  readonly permission: NoteSharePermission;
  readonly createdAt: IsoTimestamp;
}

export interface NoteShareList {
  readonly items: readonly NoteShareGrant[];
  readonly limit: number;
  readonly returned: number;
  readonly truncated: boolean;
}

export interface NoteShareUpsertResult {
  readonly share: NoteShareGrant;
}

export interface NoteShareDeleteResult {
  readonly noteId: NoteId;
  readonly userId: UserId;
  readonly revoked: true;
}

export interface NoteListQuery {
  readonly page: number;
  readonly limit: number;
  readonly scope: NoteLocation;
  readonly projectId?: ProjectId;
  readonly folderId?: FolderId | null;
  readonly rootFolder?: boolean;
  readonly parentId?: NoteId | null;
  readonly rootParent?: boolean;
  readonly type?: NoteType;
  readonly view: NoteListView;
  readonly isTemplate?: boolean;
  readonly isPinned?: boolean;
  readonly isArchived?: boolean;
  readonly tagId?: TagId;
  readonly sortBy: NoteSortField;
  readonly sortDirection: "asc" | "desc";
}
