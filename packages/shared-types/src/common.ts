/** JSON values that can safely cross an API boundary. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** ISO-8601 timestamp. Runtime validation is owned by shared-validators. */
export type IsoTimestamp = string;

export type UserId = string;
export type WorkspaceId = string;
export type ProjectId = string;
export type NoteId = string;
export type FolderId = string;
export type AttachmentId = string;
export type TaskId = string;
export type TaskStatusId = string;
export type TagId = string;
export type RequestId = string;

export type SortDirection = "asc" | "desc";

export interface Sort<F extends string = string> {
  field: F;
  direction: SortDirection;
}

export interface PaginationQuery {
  page: number;
  limit: number;
}

export interface PaginationMeta extends PaginationQuery {
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: PaginationMeta;
}
