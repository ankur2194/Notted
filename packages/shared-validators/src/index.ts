/**
 * Stable public barrel for cross-boundary Zod schemas and inferred inputs.
 *
 * Import consumers from `@notted/shared-validators`, never package internals.
 */

export {
  authPasswordSchema,
  createUserProfileSchema,
  oauthProviderIdSchema,
  passkeyNameSchema,
  reauthenticateSchema,
  recoveryCodeSchema,
  registerWithPasswordSchema,
  requestEmailVerificationSchema,
  requestMagicLinkSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signInWithPasswordSchema,
  totpCodeSchema,
  updateUserProfileSchema,
  userProfileFilterSchema,
} from "./auth.schema";
export type {
  CreateUserProfileInput,
  OAuthProviderIdInput,
  ReauthenticateInput,
  RegisterWithPasswordInput,
  RequestEmailVerificationInput,
  RequestMagicLinkInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  SignInWithPasswordInput,
  UpdateUserProfileInput,
  UserProfileFilterInput,
} from "./auth.schema";
export {
  attachmentFilterSchema,
  attachmentSortFieldSchema,
  attachmentStatusSchema,
  createAttachmentIntentSchema,
  updateAttachmentIntentSchema,
} from "./attachment.schema";
export type {
  AttachmentFilterInput,
  CreateAttachmentIntentInput,
  UpdateAttachmentIntentInput,
} from "./attachment.schema";
export {
  dateRangeQuerySchema,
  explicitBooleanQuerySchema,
  idempotencyKeySchema,
  isoTimestampSchema,
  jsonValueSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  sortSchema,
  uuidSchema,
} from "./common.schema";
export type {
  DateRangeQueryInput,
  ExplicitBooleanQueryInput,
  IsoTimestampInput,
  JsonValueInput,
  PaginationQueryInput,
  SortInput,
  UuidInput,
} from "./common.schema";
export {
  createNoteMetadataSchema,
  noteMetadataFilterSchema,
  noteSortFieldSchema,
  noteTypeSchema,
  pageSizeSchema,
  updateNoteMetadataSchema,
} from "./note.schema";
export type {
  CreateNoteMetadataInput,
  NoteMetadataFilterInput,
  UpdateNoteMetadataInput,
} from "./note.schema";
export {
  createProjectSchema,
  projectCoverImageUrlSchema,
  projectCreateResultSchema,
  projectDeleteResultSchema,
  projectDetailSchema,
  projectFilterSchema,
  projectListQuerySchema,
  projectPageSchema,
  projectSortFieldSchema,
  projectStatusSchema,
  projectStatusResultSchema,
  projectSummarySchema,
  projectUpdateResultSchema,
  updateProjectSchema,
} from "./project.schema";
export type {
  CreateProjectInput,
  ProjectFilterInput,
  ProjectListQueryInput,
  UpdateProjectInput,
} from "./project.schema";
export { searchModeSchema, searchQuerySchema, searchSortSchema } from "./search.schema";
export type { SearchQueryInput } from "./search.schema";
export {
  notificationKindSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  notificationReadResultSchema,
  notificationReadStateSchema,
  notificationsMarkAllResultSchema,
  notificationSummarySchema,
  notificationTargetTypeSchema,
  shellBootstrapSchema,
  shellBootstrapQuerySchema,
  shellWorkspaceMembershipSchema,
  workspaceSelectorSchema,
} from "./shell.schema";
export type {
  NotificationListQueryInput,
  NotificationReadStateInput,
  ShellBootstrapQueryInput,
  WorkspaceSelectorInput,
} from "./shell.schema";
export {
  createTaskSchema,
  taskFilterSchema,
  taskPrioritySchema,
  taskRecurrenceSchema,
  taskSortFieldSchema,
  taskStatusSchema,
  updateTaskSchema,
} from "./task.schema";
export type { CreateTaskInput, TaskFilterInput, UpdateTaskInput } from "./task.schema";
export {
  createWorkspaceSchema,
  acceptWorkspaceInvitationSchema,
  changeWorkspaceMemberRoleSchema,
  invitationListQuerySchema,
  invitationStatusSchema,
  invitationTokenSchema,
  inviteWorkspaceMemberSchema,
  membershipEmailSchema,
  membershipListQuerySchema,
  updateWorkspaceSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceDeleteSchema,
  workspaceDetailSchema,
  workspaceFilterSchema,
  workspaceListQuerySchema,
  workspaceInvitationAcceptResultSchema,
  workspaceInvitationPageSchema,
  workspaceInvitationResendResultSchema,
  workspaceInvitationRevokeResultSchema,
  workspaceInvitationSummarySchema,
  workspaceInviteResultSchema,
  workspaceMemberLeaveResultSchema,
  workspaceMemberPageSchema,
  workspaceMemberRemoveResultSchema,
  workspaceMemberRoleChangeResultSchema,
  workspaceMemberSummarySchema,
  workspacePageSchema,
  workspacePlanSchema,
  workspaceRoleSchema,
  workspaceSettingsSchema,
  workspaceSortFieldSchema,
  workspaceSummarySchema,
  workspaceUpdateResultSchema,
} from "./workspace.schema";
export type {
  AcceptWorkspaceInvitationInput,
  ChangeWorkspaceMemberRoleInput,
  CreateWorkspaceInput,
  InvitationListQueryInput,
  InviteWorkspaceMemberInput,
  MembershipListQueryInput,
  UpdateWorkspaceInput,
  WorkspaceDeleteInput,
  WorkspaceFilterInput,
  WorkspaceListQueryInput,
} from "./workspace.schema";
