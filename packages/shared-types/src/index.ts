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
export { API_KEY_API_PATHS, API_KEY_SECRET_PREFIX } from "./api-key";
export type {
  ApiKeyCreateResult,
  ApiKeyListQuery,
  ApiKeyPage,
  ApiKeyRevokeResult,
  ApiKeyScope,
  ApiKeySortField,
  ApiKeySummary,
} from "./api-key";
export { ATTACHMENT_API_PATHS } from "./attachment";
export type {
  AttachmentBlurPlaceholder,
  AttachmentDeleteResult,
  AttachmentDetail,
  AttachmentListResult,
  AttachmentMedia,
  AttachmentMediaType,
  AttachmentServableVariant,
  AttachmentStatus,
  AttachmentSummary,
  AttachmentUploadResult,
  AttachmentVariantName,
  AttachmentVariantProjection,
  AttachmentVariantSet,
} from "./attachment";
export { COMMENT_API_PATHS } from "./comment";
export type {
  CommentAnchor,
  CommentAnchorScheme,
  CommentAuthor,
  CommentChangedEvent,
  CommentDeleteResult,
  CommentMutationResult,
  CommentPage,
  CommentSummary,
  CommentThread,
} from "./comment";
export type {
  AttachmentId,
  FolderId,
  IsoTimestamp,
  JsonPrimitive,
  JsonValue,
  NoteId,
  Paginated,
  PaginationMeta,
  PaginationQuery,
  Progress,
  ProjectId,
  RequestId,
  Sort,
  SortDirection,
  TagId,
  TaskId,
  TaskStatusId,
  UserId,
  WorkspaceId,
} from "./common";
export { EXPORT_API_PATHS, SUPPORTED_EXPORT_FORMATS, SUPPORTED_EXPORT_SOURCES } from "./export";
export type {
  ExportCancelResult,
  ExportFormat,
  ExportJob,
  ExportOptions,
  ExportPage,
  ExportSource,
  ExportStatus,
} from "./export";
export { NOTE_API_PATHS } from "./note";
export type {
  FolderCreateResult,
  FolderDeleteResult,
  FolderPage,
  FolderSummary,
  FolderUpdateResult,
  NoteCreateResult,
  NoteVersionDetail,
  NoteVersionPage,
  NoteVersionRestoreResult,
  NoteVersionSummary,
  NoteDeleteResult,
  NoteDetail,
  NoteDocument,
  NoteListQuery,
  NoteListView,
  NoteLocation,
  NoteMoveResult,
  NoteNavigation,
  NoteNavigationItem,
  NotePage,
  NotePermanentDeleteResult,
  NoteRestoreResult,
  NoteShareDeleteResult,
  NoteShareGrant,
  NoteShareList,
  NoteShareMutationPermission,
  NoteSharePermission,
  NoteShareUpsertResult,
  NoteSortField,
  NoteSummary,
  NoteType,
  NoteUpdateResult,
  PageSize,
} from "./note";
/**
 * Physical page geometry (Part 37/38, moved here by Part 63).
 *
 * It lived in `apps/web` until the PDF/HTML export renderer in `apps/api` had
 * to emit the SAME `@page` rule the editor prints with. ADR 0001 forbids an
 * app importing an app, and the API image contains no `apps/web` sources, so
 * the arithmetic moved to the one place both apps already depend on. It is
 * pure, framework-free and unit-agnostic — no DOM, no React, no Zod.
 */
export * from "./page-geometry";
export { PROJECT_API_PATHS } from "./project";
export type {
  ProjectCreateResult,
  ProjectDeleteResult,
  ProjectDetail,
  ProjectListQuery,
  ProjectMember,
  ProjectMemberAccessSource,
  ProjectMutationProject,
  ProjectPage,
  ProjectAccessRole,
  ProjectSortField,
  ProjectStatus,
  ProjectStatusResult,
  ProjectSummary,
  ProjectTaskProgress,
  ProjectUpdateResult,
} from "./project";
export { SHELL_API_PATHS } from "./shell";
export type {
  NotificationEmailPreference,
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
export { SEARCH_API_PATHS } from "./search";
export type {
  RecentSearch,
  RecentSearchesPayload,
  SearchAvailability,
  SearchHighlight,
  SearchMode,
  SearchPage,
  SearchResult,
  SearchResultSummary,
  SearchSort,
  SearchSortDirection,
  SearchSuggestion,
} from "./search";
export { TAG_API_PATHS } from "./tag";
export type {
  TagCreateResult,
  TagDeleteResult,
  TagListQuery,
  TagPage,
  TagSortField,
  TagSummary,
  TagUpdateResult,
} from "./tag";
export { TASK_API_PATHS, TASK_STATUS_API_PATHS } from "./task";
export type {
  CustomTaskStatus,
  CustomTaskStatusList,
  TaskBulkResult,
  TaskBulkSkip,
  TaskBulkSkipReason,
  TaskCreateResult,
  TaskDeleteResult,
  TaskDetail,
  TaskGrouping,
  TaskListQuery,
  TaskPage,
  TaskPriority,
  TaskRecurrence,
  TaskReorderResult,
  TaskSortField,
  TaskStatus,
  TaskStatusDeleteResult,
  TaskStatusMutationResult,
  TaskSummary,
  TaskUpdateResult,
} from "./task";
export { MEMBERSHIP_API_PATHS, WORKSPACE_API_PATHS } from "./workspace";
export type {
  MembershipListQuery,
  StorageMaintenanceReport,
  StorageMaintenanceSweepName,
  StorageMaintenanceSweepReport,
  WorkspaceStorageUsage,
  WorkspaceInvitationAcceptResult,
  WorkspaceInvitationPage,
  WorkspaceInvitationResendResult,
  WorkspaceInvitationRevokeResult,
  WorkspaceInvitationStatus,
  WorkspaceInvitationSummary,
  WorkspaceInviteResult,
  WorkspaceCreateResult,
  WorkspaceDeleteResult,
  WorkspaceDetail,
  WorkspaceListQuery,
  WorkspaceMemberLeaveResult,
  WorkspaceMemberPage,
  WorkspaceMemberRemoveResult,
  WorkspaceMemberRoleChangeResult,
  WorkspaceMemberSummary,
  WorkspacePage,
  WorkspacePlan,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceSummary,
  WorkspaceUpdateResult,
} from "./workspace";

// Part 66 — outbound webhooks and delivery logs.
export {
  WEBHOOK_API_PATHS,
  WEBHOOK_DELIVERY_ERROR_CODES,
  WEBHOOK_ENDPOINT_LIMIT,
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_VERIFICATION_EVENT,
} from "./webhook";
export type {
  WebhookCreateResult,
  WebhookDeleteResult,
  WebhookDelivery,
  WebhookDeliveryErrorCode,
  WebhookDeliveryListQuery,
  WebhookDeliveryPage,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointPage,
  WebhookEvent,
  WebhookRetryResult,
  WebhookSecretRotationResult,
  WebhookVerificationResult,
} from "./webhook";
