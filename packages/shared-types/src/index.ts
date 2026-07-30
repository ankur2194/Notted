/**
 * Stable public barrel for framework-neutral Notted transport contracts.
 *
 * Import consumers from `@notted/shared-types`, never package internals.
 * Database rows, provider SDK objects, credentials, storage secrets, remote
 * asset URLs, signed URLs, and persisted editor/CRDT documents are excluded.
 */

/** Product/application display name. */
export const APP_NAME = "Notted" as const;

export type {
  ApiError,
  ApiErrorCode,
  ApiFailure,
  ApiResponse,
  ApiSuccess,
  ValidationErrorDetails,
  ValidationIssue,
} from "./api";
export type {
  AuthCapabilities,
  AuthEmailAccepted,
  AuthPasskeySummary,
  AuthSecurityOverview,
  AuthSessionSummary,
  AuthenticatedPrincipal,
  AuthenticationAssurance,
  AuthenticationMethod,
  OAuthProviderId,
  OAuthProviderSummary,
  UserDetail,
  UserSummary,
} from "./auth";
export { AUTH_API_PATHS } from "./auth";
export type { AttachmentDetail, AttachmentStatus, AttachmentSummary } from "./attachment";
export type {
  AttachmentId,
  IsoTimestamp,
  JsonPrimitive,
  JsonValue,
  NoteId,
  Paginated,
  PaginationMeta,
  PaginationQuery,
  ProjectId,
  RequestId,
  Sort,
  SortDirection,
  TagId,
  TaskId,
  UserId,
  WorkspaceId,
} from "./common";
export type { NoteDetail, NoteSummary, NoteType, PageSize } from "./note";
export type { ProjectDetail, ProjectStatus, ProjectSummary } from "./project";
export { SHELL_API_PATHS } from "./shell";
export type {
  NotificationKind,
  NotificationPage,
  NotificationReadResult,
  NotificationsMarkAllResult,
  NotificationSummary,
  NotificationTargetType,
  ShellBootstrap,
  ShellPresentationPermissions,
  ShellUserSummary,
  ShellWorkspaceMembership,
} from "./shell";
export type {
  SearchHighlight,
  SearchMode,
  SearchResultDetail,
  SearchResultSummary,
} from "./search";
export type { TaskDetail, TaskPriority, TaskRecurrence, TaskStatus, TaskSummary } from "./task";
export type { WorkspaceDetail, WorkspacePlan, WorkspaceRole, WorkspaceSummary } from "./workspace";
