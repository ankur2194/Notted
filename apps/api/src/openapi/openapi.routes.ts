import {
  acceptWorkspaceInvitationSchema,
  aiConfigUpdateSchema,
  aiConfigViewSchema,
  aiContinueRequestSchema,
  aiGrammarCheckRequestSchema,
  aiGrammarCheckResultSchema,
  aiMeetingExtractionRequestSchema,
  aiMeetingExtractionResultSchema,
  aiRewriteRequestSchema,
  aiStatusSchema,
  aiSummarizeRequestSchema,
  aiTagSuggestionRequestSchema,
  aiTagSuggestionResultSchema,
  aiUsageQuerySchema,
  aiUsageSummarySchema,
  apiKeyCreateResultSchema,
  apiKeyListQuerySchema,
  apiKeyPageSchema,
  apiKeyRevokeResultSchema,
  attachmentContentQuerySchema,
  attachmentDeleteResultSchema,
  attachmentListResultSchema,
  attachmentUploadResultSchema,
  bulkTaskSchema,
  changeWorkspaceMemberRoleSchema,
  commentDeleteResultSchema,
  commentListQuerySchema,
  commentMutationResultSchema,
  commentPageSchema,
  commentResolutionSchema,
  copyNoteSchema,
  createApiKeySchema,
  createCommentSchema,
  createFolderSchema,
  createNoteSchema,
  createProjectSchema,
  createTagSchema,
  createTaskSchema,
  createTaskStatusSchema,
  createWorkspaceSchema,
  customTaskStatusListSchema,
  deleteFolderSchema,
  deleteNoteSchema,
  exportCreateSchema,
  exportListQuerySchema,
  folderCreateResultSchema,
  folderDeleteResultSchema,
  folderListQuerySchema,
  folderPageSchema,
  folderUpdateResultSchema,
  invitationListQuerySchema,
  inviteWorkspaceMemberSchema,
  membershipListQuerySchema,
  moveNoteSchema,
  noteCreateResultSchema,
  noteDeleteResultSchema,
  noteDetailSchema,
  noteListQuerySchema,
  noteMoveResultSchema,
  noteNavigationQuerySchema,
  noteNavigationSchema,
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
  notificationEmailPreferenceSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  notificationReadResultSchema,
  notificationReadStateSchema,
  notificationsMarkAllResultSchema,
  paginationQuerySchema,
  permanentDeleteNoteSchema,
  projectCreateResultSchema,
  projectDeleteResultSchema,
  projectDetailSchema,
  projectListQuerySchema,
  projectPageSchema,
  projectStatusResultSchema,
  projectUpdateResultSchema,
  reorderTaskSchema,
  restoreNoteSchema,
  restoreNoteVersionSchema,
  searchPageSchema,
  searchQuerySchema,
  searchSuggestionQuerySchema,
  searchSuggestionSchema,
  shellBootstrapQuerySchema,
  shellBootstrapSchema,
  storageMaintenanceReportSchema,
  storageMaintenanceRequestSchema,
  tagCreateResultSchema,
  tagDeleteResultSchema,
  tagListQuerySchema,
  tagPageSchema,
  tagUpdateResultSchema,
  taskBulkResultSchema,
  taskCreateResultSchema,
  taskDeleteResultSchema,
  taskDetailSchema,
  taskListQuerySchema,
  taskPageSchema,
  taskReorderResultSchema,
  taskStatusDeleteResultSchema,
  taskStatusListQuerySchema,
  taskStatusMutationResultSchema,
  taskUpdateResultSchema,
  updateCommentSchema,
  updateFolderSchema,
  updateNoteSchema,
  updateProjectSchema,
  updateTagSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  updateWorkspaceSchema,
  upsertNoteShareSchema,
  webhookCreateResultSchema,
  webhookCreateSchema,
  webhookDeleteResultSchema,
  webhookDeliveryListQuerySchema,
  webhookDeliveryPageSchema,
  webhookEndpointPageSchema,
  webhookEndpointSchema,
  webhookRetryResultSchema,
  webhookSecretRotationResultSchema,
  webhookUpdateSchema,
  webhookVerificationResultSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceDeleteSchema,
  workspaceDetailSchema,
  workspaceInvitationAcceptResultSchema,
  workspaceInvitationPageSchema,
  workspaceInvitationResendResultSchema,
  workspaceInvitationRevokeResultSchema,
  workspaceInviteResultSchema,
  workspaceListQuerySchema,
  workspaceMemberLeaveResultSchema,
  workspaceMemberPageSchema,
  workspaceMemberRemoveResultSchema,
  workspaceMemberRoleChangeResultSchema,
  workspacePageSchema,
  workspaceStorageUsageSchema,
  workspaceUpdateResultSchema,
} from "@notted/shared-validators";

import type { ZodType } from "zod";

/**
 * Documentation for one REST operation.
 *
 * `query`, `body`, and `response` reference schemas that already exist in
 * `@notted/shared-validators`. A part with no committed schema is omitted and
 * explained in `description` rather than described by a schema invented here.
 */
export interface OpenApiRouteDoc {
  readonly summary: string;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly query?: ZodType;
  readonly body?: ZodType;
  readonly response?: ZodType;
  /** The handler resolves to a list of `response` rather than a single value. */
  readonly responseIsArray?: boolean;
}

/**
 * Route documentation keyed by `"<METHOD> <path>"`, where `<path>` is the
 * OpenAPI-shaped route (`{param}`, no `/api/v1` prefix) exactly as
 * `discoverRoutes()` in `openapi.builder.ts` reports it.
 *
 * The contract test asserts this map and the discovered route inventory match
 * in both directions, so a new controller route fails the build until it is
 * documented here and a removed one fails until its entry goes.
 *
 * Extension point: later parts (Part 66 webhooks) add their own resource group
 * to this object literal. Keep it a plain grouped map — no registry class.
 */
/**
 * Shared by the three Part 68 streaming routes, because the thing a caller has
 * to understand is identical for all three and stating it once keeps it so.
 */
const SSE_STREAM_DESCRIPTION =
  "Responds with `text/event-stream`, not JSON: a sequence of `data:` frames, each one an `AiStreamEvent` from @notted/shared-types — `delta` (text), then exactly one terminator, either `done` (promptVersion and token counts) or `error` (a stream error code). A stream that stops without a terminator was cut off and must be treated as a failure. Governance refusals — AI disabled, not configured, consent missing, quota exhausted, rate limited — are answered BEFORE the stream begins, as an ordinary JSON error envelope with the usual status code (and `Retry-After` where one applies), so a client must check the response status and content type before it starts parsing frames. Note text is sent in the request body rather than read from the stored note, because a live collaborative session holds the freshest document in the browser; `noteId` is still required and still authorized. Nothing generated here is retained: only token counts reach `ai_usage`.";

export const OPENAPI_ROUTES: Record<string, OpenApiRouteDoc> = {
  // Meta. Unauthenticated service and document endpoints.
  "GET /": { summary: "API root and version banner.", tags: ["Meta"] },
  "GET /openapi.json": {
    summary: "This OpenAPI document.",
    tags: ["Meta"],
    description: "Served from the running code, so it cannot drift from the routes it documents.",
  },
  "GET /health/live": {
    summary: "Liveness probe.",
    tags: ["Meta"],
    description: "Excluded from the /api/v1 prefix so orchestrators can probe a stable path.",
  },
  "GET /health/ready": {
    summary: "Readiness probe with per-dependency checks.",
    tags: ["Meta"],
    description: "Excluded from the /api/v1 prefix. 503 while any dependency is down.",
  },

  // Auth. Browser-session surface; API keys are not accepted here.
  "GET /auth/capabilities": {
    summary: "Enabled authentication capabilities for this deployment.",
    tags: ["Auth"],
    description: "No committed response schema; see @notted/shared-types AuthCapabilities.",
  },
  "GET /auth/session": {
    summary: "The authenticated principal for the current session.",
    tags: ["Auth"],
    description: "No committed response schema; see @notted/shared-types AuthenticatedPrincipal.",
  },
  "GET /auth/security": {
    summary: "Security overview: sessions, passkeys, and second factors.",
    tags: ["Auth"],
    description: "No committed response schema; see @notted/shared-types AuthSecurityOverview.",
  },
  "POST /auth/sessions/revoke-others": {
    summary: "Revoke every session except the current one.",
    tags: ["Auth"],
  },
  "DELETE /auth/sessions/{sessionId}": {
    summary: "Revoke one session.",
    tags: ["Auth"],
  },

  // Shell. First-load bootstrap for the web client.
  "GET /shell/bootstrap": {
    summary: "Workspace memberships and shell state for the signed-in user.",
    tags: ["Shell"],
    query: shellBootstrapQuerySchema,
    response: shellBootstrapSchema,
  },

  // Workspaces.
  "POST /workspaces": {
    summary: "Create a workspace.",
    tags: ["Workspaces"],
    body: createWorkspaceSchema,
    response: workspaceCreateResultSchema,
  },
  "GET /workspaces": {
    summary: "List workspaces the caller belongs to.",
    tags: ["Workspaces"],
    query: workspaceListQuerySchema,
    response: workspacePageSchema,
  },
  "GET /workspaces/{id}": {
    summary: "Read one workspace.",
    tags: ["Workspaces"],
    response: workspaceDetailSchema,
  },
  "PATCH /workspaces/{id}": {
    summary: "Update workspace name, slug, or settings.",
    tags: ["Workspaces"],
    body: updateWorkspaceSchema,
    response: workspaceUpdateResultSchema,
  },
  "DELETE /workspaces/{id}": {
    summary: "Delete a workspace.",
    tags: ["Workspaces"],
    body: workspaceDeleteSchema,
    response: workspaceDeleteResultSchema,
  },

  // Memberships and invitations.
  "GET /workspaces/{workspaceId}/members": {
    summary: "List workspace members.",
    tags: ["Members"],
    query: membershipListQuerySchema,
    response: workspaceMemberPageSchema,
  },
  "PATCH /workspaces/{workspaceId}/members/{memberId}": {
    summary: "Change a member's role.",
    tags: ["Members"],
    body: changeWorkspaceMemberRoleSchema,
    response: workspaceMemberRoleChangeResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/members/{memberId}": {
    summary: "Remove a member from the workspace.",
    tags: ["Members"],
    response: workspaceMemberRemoveResultSchema,
  },
  "POST /workspaces/{workspaceId}/members/leave": {
    summary: "Leave the workspace.",
    tags: ["Members"],
    response: workspaceMemberLeaveResultSchema,
  },
  "GET /workspaces/{workspaceId}/invitations": {
    summary: "List workspace invitations.",
    tags: ["Members"],
    query: invitationListQuerySchema,
    response: workspaceInvitationPageSchema,
  },
  "POST /workspaces/{workspaceId}/invitations": {
    summary: "Invite a member by email.",
    tags: ["Members"],
    body: inviteWorkspaceMemberSchema,
    response: workspaceInviteResultSchema,
  },
  "POST /workspaces/{workspaceId}/invitations/{invitationId}/resend": {
    summary: "Resend an invitation email.",
    tags: ["Members"],
    response: workspaceInvitationResendResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/invitations/{invitationId}": {
    summary: "Revoke a pending invitation.",
    tags: ["Members"],
    response: workspaceInvitationRevokeResultSchema,
  },
  "POST /invitations/accept": {
    summary: "Accept an invitation with its token.",
    tags: ["Members"],
    body: acceptWorkspaceInvitationSchema,
    response: workspaceInvitationAcceptResultSchema,
  },

  // API keys. Part 65 integration credentials.
  "GET /workspaces/{workspaceId}/api-keys": {
    summary: "List the workspace's API keys.",
    tags: ["API keys"],
    description: "Never returns the secret or its hash; only the display prefix.",
    query: apiKeyListQuerySchema,
    response: apiKeyPageSchema,
  },
  "POST /workspaces/{workspaceId}/api-keys": {
    summary: "Issue an API key.",
    tags: ["API keys"],
    description: "The only response that carries the raw secret. It is shown exactly once.",
    body: createApiKeySchema,
    response: apiKeyCreateResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/api-keys/{apiKeyId}": {
    summary: "Revoke an API key.",
    tags: ["API keys"],
    response: apiKeyRevokeResultSchema,
  },

  // Notes.
  "GET /workspaces/{workspaceId}/notes": {
    summary: "List notes.",
    tags: ["Notes"],
    query: noteListQuerySchema,
    response: notePageSchema,
  },
  "POST /workspaces/{workspaceId}/notes": {
    summary: "Create a note.",
    tags: ["Notes"],
    body: createNoteSchema,
    response: noteCreateResultSchema,
  },
  "GET /workspaces/{workspaceId}/notes/navigation": {
    summary: "Note and folder navigation tree.",
    tags: ["Notes"],
    query: noteNavigationQuerySchema,
    response: noteNavigationSchema,
  },
  "GET /workspaces/{workspaceId}/notes/{noteId}": {
    summary: "Read one note with its document.",
    tags: ["Notes"],
    response: noteDetailSchema,
  },
  "PATCH /workspaces/{workspaceId}/notes/{noteId}": {
    summary: "Update a note.",
    tags: ["Notes"],
    body: updateNoteSchema,
    response: noteUpdateResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/notes/{noteId}": {
    summary: "Move a note to the trash.",
    tags: ["Notes"],
    body: deleteNoteSchema,
    response: noteDeleteResultSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/move": {
    summary: "Move a note to another folder or project.",
    tags: ["Notes"],
    body: moveNoteSchema,
    response: noteMoveResultSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/copy": {
    summary: "Copy a note.",
    tags: ["Notes"],
    body: copyNoteSchema,
    response: noteCreateResultSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/restore": {
    summary: "Restore a trashed note.",
    tags: ["Notes"],
    body: restoreNoteSchema,
    response: noteRestoreResultSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/permanent-delete": {
    summary: "Permanently delete a trashed note.",
    tags: ["Notes"],
    body: permanentDeleteNoteSchema,
    response: notePermanentDeleteResultSchema,
  },
  "GET /workspaces/{workspaceId}/notes/{noteId}/versions": {
    summary: "List a note's version history.",
    tags: ["Notes"],
    query: noteVersionListQuerySchema,
    response: noteVersionPageSchema,
  },
  "GET /workspaces/{workspaceId}/notes/{noteId}/versions/{versionId}": {
    summary: "Read one note version.",
    tags: ["Notes"],
    response: noteVersionDetailSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/versions/{versionId}/restore": {
    summary: "Restore a note to an earlier version.",
    tags: ["Notes"],
    body: restoreNoteVersionSchema,
    response: noteVersionRestoreResultSchema,
  },

  // Note shares.
  "GET /workspaces/{workspaceId}/notes/{noteId}/shares": {
    summary: "List per-user shares on a note.",
    tags: ["Note shares"],
    response: noteShareListSchema,
  },
  "PUT /workspaces/{workspaceId}/notes/{noteId}/shares/{userId}": {
    summary: "Grant or change a user's share permission.",
    tags: ["Note shares"],
    body: upsertNoteShareSchema,
    response: noteShareUpsertResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/notes/{noteId}/shares/{userId}": {
    summary: "Revoke a user's share.",
    tags: ["Note shares"],
    response: noteShareDeleteResultSchema,
  },

  // Folders.
  "GET /workspaces/{workspaceId}/folders": {
    summary: "List folders.",
    tags: ["Folders"],
    query: folderListQuerySchema,
    response: folderPageSchema,
  },
  "POST /workspaces/{workspaceId}/folders": {
    summary: "Create a folder.",
    tags: ["Folders"],
    body: createFolderSchema,
    response: folderCreateResultSchema,
  },
  "PATCH /workspaces/{workspaceId}/folders/{folderId}": {
    summary: "Rename or move a folder.",
    tags: ["Folders"],
    body: updateFolderSchema,
    response: folderUpdateResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/folders/{folderId}": {
    summary: "Delete a folder.",
    tags: ["Folders"],
    body: deleteFolderSchema,
    response: folderDeleteResultSchema,
  },

  // Comments.
  "GET /workspaces/{workspaceId}/notes/{noteId}/comments": {
    summary: "List comment threads on a note.",
    tags: ["Comments"],
    query: commentListQuerySchema,
    response: commentPageSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/comments": {
    summary: "Create a comment or reply.",
    tags: ["Comments"],
    body: createCommentSchema,
    response: commentMutationResultSchema,
  },
  "PATCH /workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}": {
    summary: "Edit a comment.",
    tags: ["Comments"],
    body: updateCommentSchema,
    response: commentMutationResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}": {
    summary: "Delete a comment.",
    tags: ["Comments"],
    response: commentDeleteResultSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}/resolution": {
    summary: "Resolve or reopen a comment thread.",
    tags: ["Comments"],
    body: commentResolutionSchema,
    response: commentMutationResultSchema,
  },

  // Attachments.
  "GET /workspaces/{workspaceId}/notes/{noteId}/attachments": {
    summary: "List a note's attachments.",
    tags: ["Attachments"],
    response: attachmentListResultSchema,
  },
  "POST /workspaces/{workspaceId}/notes/{noteId}/attachments": {
    summary: "Upload an attachment.",
    tags: ["Attachments"],
    description: "multipart/form-data upload; the request body has no committed Zod schema.",
    response: attachmentUploadResultSchema,
  },
  "GET /workspaces/{workspaceId}/attachments/{attachmentId}/content": {
    summary: "Stream attachment bytes.",
    tags: ["Attachments"],
    description: "Streams the stored object; the response is binary, not JSON.",
    query: attachmentContentQuerySchema,
  },
  "DELETE /workspaces/{workspaceId}/attachments/{attachmentId}": {
    summary: "Delete an attachment.",
    tags: ["Attachments"],
    response: attachmentDeleteResultSchema,
  },

  // Tags.
  "GET /workspaces/{workspaceId}/tags": {
    summary: "List tags.",
    tags: ["Tags"],
    query: tagListQuerySchema,
    response: tagPageSchema,
  },
  "POST /workspaces/{workspaceId}/tags": {
    summary: "Create a tag.",
    tags: ["Tags"],
    body: createTagSchema,
    response: tagCreateResultSchema,
  },
  "PATCH /workspaces/{workspaceId}/tags/{tagId}": {
    summary: "Update a tag.",
    tags: ["Tags"],
    body: updateTagSchema,
    response: tagUpdateResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/tags/{tagId}": {
    summary: "Delete a tag.",
    tags: ["Tags"],
    response: tagDeleteResultSchema,
  },

  // Tasks.
  "GET /workspaces/{workspaceId}/tasks": {
    summary: "List tasks.",
    tags: ["Tasks"],
    query: taskListQuerySchema,
    response: taskPageSchema,
  },
  "POST /workspaces/{workspaceId}/tasks": {
    summary: "Create a task.",
    tags: ["Tasks"],
    body: createTaskSchema,
    response: taskCreateResultSchema,
  },
  "POST /workspaces/{workspaceId}/tasks/bulk": {
    summary: "Apply a bulk operation to several tasks.",
    tags: ["Tasks"],
    body: bulkTaskSchema,
    response: taskBulkResultSchema,
  },
  "GET /workspaces/{workspaceId}/tasks/{taskId}": {
    summary: "Read one task.",
    tags: ["Tasks"],
    response: taskDetailSchema,
  },
  "PATCH /workspaces/{workspaceId}/tasks/{taskId}": {
    summary: "Update a task.",
    tags: ["Tasks"],
    body: updateTaskSchema,
    response: taskUpdateResultSchema,
  },
  "POST /workspaces/{workspaceId}/tasks/{taskId}/reorder": {
    summary: "Reorder a task within its status column.",
    tags: ["Tasks"],
    body: reorderTaskSchema,
    response: taskReorderResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/tasks/{taskId}": {
    summary: "Delete a task.",
    tags: ["Tasks"],
    response: taskDeleteResultSchema,
  },

  // Task statuses.
  "GET /workspaces/{workspaceId}/task-statuses": {
    summary: "List custom task statuses.",
    tags: ["Task statuses"],
    query: taskStatusListQuerySchema,
    response: customTaskStatusListSchema,
  },
  "POST /workspaces/{workspaceId}/task-statuses": {
    summary: "Create a custom task status.",
    tags: ["Task statuses"],
    body: createTaskStatusSchema,
    response: taskStatusMutationResultSchema,
  },
  "PATCH /workspaces/{workspaceId}/task-statuses/{statusId}": {
    summary: "Update a custom task status.",
    tags: ["Task statuses"],
    body: updateTaskStatusSchema,
    response: taskStatusMutationResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/task-statuses/{statusId}": {
    summary: "Delete a custom task status.",
    tags: ["Task statuses"],
    response: taskStatusDeleteResultSchema,
  },

  // Projects.
  "GET /workspaces/{workspaceId}/projects": {
    summary: "List projects.",
    tags: ["Projects"],
    query: projectListQuerySchema,
    response: projectPageSchema,
  },
  "POST /workspaces/{workspaceId}/projects": {
    summary: "Create a project.",
    tags: ["Projects"],
    body: createProjectSchema,
    response: projectCreateResultSchema,
  },
  "GET /workspaces/{workspaceId}/projects/{projectId}": {
    summary: "Read one project.",
    tags: ["Projects"],
    response: projectDetailSchema,
  },
  "PATCH /workspaces/{workspaceId}/projects/{projectId}": {
    summary: "Update a project.",
    tags: ["Projects"],
    body: updateProjectSchema,
    response: projectUpdateResultSchema,
  },
  "POST /workspaces/{workspaceId}/projects/{projectId}/archive": {
    summary: "Archive a project.",
    tags: ["Projects"],
    response: projectStatusResultSchema,
  },
  "POST /workspaces/{workspaceId}/projects/{projectId}/complete": {
    summary: "Mark a project complete.",
    tags: ["Projects"],
    response: projectStatusResultSchema,
  },
  "POST /workspaces/{workspaceId}/projects/{projectId}/restore": {
    summary: "Restore an archived or completed project to active.",
    tags: ["Projects"],
    response: projectStatusResultSchema,
  },
  "DELETE /workspaces/{workspaceId}/projects/{projectId}": {
    summary: "Delete a project.",
    tags: ["Projects"],
    response: projectDeleteResultSchema,
  },

  // Search.
  "GET /workspaces/{workspaceId}/search": {
    summary: "Full-text, semantic, or hybrid search over authorized notes.",
    tags: ["Search"],
    query: searchQuerySchema,
    response: searchPageSchema,
  },
  "GET /workspaces/{workspaceId}/search/suggestions": {
    summary: "Typeahead suggestions.",
    tags: ["Search"],
    query: searchSuggestionQuerySchema,
    response: searchSuggestionSchema,
    responseIsArray: true,
  },

  // Storage.
  "GET /workspaces/{workspaceId}/storage": {
    summary: "Workspace storage usage.",
    tags: ["Storage"],
    response: workspaceStorageUsageSchema,
  },
  "POST /workspaces/{workspaceId}/storage/maintenance": {
    summary: "Run storage maintenance sweeps.",
    tags: ["Storage"],
    body: storageMaintenanceRequestSchema,
    response: storageMaintenanceReportSchema,
  },

  // Notifications.
  "GET /workspaces/{workspaceId}/notifications": {
    summary: "List notifications.",
    tags: ["Notifications"],
    query: notificationListQuerySchema,
    response: notificationPageSchema,
  },
  "POST /workspaces/{workspaceId}/notifications/read-all": {
    summary: "Mark every notification read.",
    tags: ["Notifications"],
    response: notificationsMarkAllResultSchema,
  },
  "GET /workspaces/{workspaceId}/notifications/email-preference": {
    summary: "Read the caller's notification email preference.",
    tags: ["Notifications"],
    response: notificationEmailPreferenceSchema,
  },
  "POST /workspaces/{workspaceId}/notifications/email-preference": {
    summary: "Update the caller's notification email preference.",
    tags: ["Notifications"],
    body: notificationEmailPreferenceSchema,
    response: notificationEmailPreferenceSchema,
  },
  "PATCH /workspaces/{workspaceId}/notifications/{notificationId}": {
    summary: "Mark one notification read or unread.",
    tags: ["Notifications"],
    body: notificationReadStateSchema,
    response: notificationReadResultSchema,
  },

  // Exports.
  "POST /workspaces/{workspaceId}/exports": {
    summary: "Queue an export job.",
    tags: ["Exports"],
    description: "No committed response schema; see @notted/shared-types ExportJob.",
    body: exportCreateSchema,
  },
  "GET /workspaces/{workspaceId}/exports": {
    summary: "List export jobs.",
    tags: ["Exports"],
    description: "No committed response schema; see @notted/shared-types ExportPage.",
    query: exportListQuerySchema,
  },
  "GET /workspaces/{workspaceId}/exports/{exportId}": {
    summary: "Read one export job.",
    tags: ["Exports"],
    description: "No committed response schema; see @notted/shared-types ExportJob.",
  },
  "POST /workspaces/{workspaceId}/exports/{exportId}/cancel": {
    summary: "Cancel a queued or running export job.",
    tags: ["Exports"],
    description: "No committed response schema; see @notted/shared-types ExportJob.",
  },
  "GET /workspaces/{workspaceId}/exports/{exportId}/download": {
    summary: "Download a completed export artifact.",
    tags: ["Exports"],
    description: "Streams the stored artifact; the response is binary, not JSON.",
  },

  // Webhooks. Part 66 outbound delivery and its logs.
  "GET /workspaces/{workspaceId}/webhooks": {
    summary: "List the workspace's webhook endpoints.",
    tags: ["Webhooks"],
    description: "Never returns the signing secret; only its ciphertext is stored.",
    query: paginationQuerySchema,
    response: webhookEndpointPageSchema,
  },
  "POST /workspaces/{workspaceId}/webhooks": {
    summary: "Register a webhook endpoint.",
    tags: ["Webhooks"],
    description:
      "One of only two responses that carry the raw signing secret, and it is shown exactly once. The endpoint arrives disabled and unverified.",
    body: webhookCreateSchema,
    response: webhookCreateResultSchema,
  },
  "PATCH /workspaces/{workspaceId}/webhooks/{webhookId}": {
    summary: "Update a webhook endpoint.",
    tags: ["Webhooks"],
    description:
      "An endpoint cannot be enabled until it is verified. Changing the URL resets both flags.",
    body: webhookUpdateSchema,
    response: webhookEndpointSchema,
  },
  "DELETE /workspaces/{workspaceId}/webhooks/{webhookId}": {
    summary: "Delete a webhook endpoint.",
    tags: ["Webhooks"],
    response: webhookDeleteResultSchema,
  },
  "POST /workspaces/{workspaceId}/webhooks/{webhookId}/rotate-secret": {
    summary: "Rotate an endpoint's signing secret.",
    tags: ["Webhooks"],
    description:
      "The other response that carries the raw signing secret, shown exactly once. The new secret signs in-flight retries immediately.",
    response: webhookSecretRotationResultSchema,
  },
  "POST /workspaces/{workspaceId}/webhooks/{webhookId}/verify": {
    summary: "Send the verification challenge to an endpoint.",
    tags: ["Webhooks"],
    description:
      "Sends one signed request to the endpoint synchronously and records a delivery attempt either way. An endpoint cannot be enabled until it is verified.",
    response: webhookVerificationResultSchema,
  },
  "GET /workspaces/{workspaceId}/webhooks/{webhookId}/deliveries": {
    summary: "List an endpoint's delivery attempts.",
    tags: ["Webhooks"],
    description: "One immutable row per attempt; the request body and signature are never stored.",
    query: webhookDeliveryListQuerySchema,
    response: webhookDeliveryPageSchema,
  },
  "POST /workspaces/{workspaceId}/webhooks/{webhookId}/deliveries/{deliveryId}/retry": {
    summary: "Replay a recorded delivery.",
    tags: ["Webhooks"],
    description:
      "Replays the same event with the same event id under a fresh attempt budget, so a receiver deduplicating on it sees a repeat rather than a new event.",
    response: webhookRetryResultSchema,
  },

  // AI. Part 67 provider configuration, governance, and usage reporting.
  "GET /workspaces/{workspaceId}/ai/config": {
    summary: "Read the workspace's AI provider configuration.",
    tags: ["AI"],
    description:
      "The stored provider credential is never returned; the response says only whether one is configured. A workspace that has never been configured reads as disabled rather than 404.",
    response: aiConfigViewSchema,
  },
  "PUT /workspaces/{workspaceId}/ai/config": {
    summary: "Replace the workspace's AI provider configuration.",
    tags: ["AI"],
    description:
      "The whole desired configuration, applied as a replacement. Omitting apiKey keeps the stored credential; switching providers, or enabling AI with none stored, requires a new one. The credential is never returned by this or any other route.",
    body: aiConfigUpdateSchema,
    response: aiConfigViewSchema,
  },
  "GET /workspaces/{workspaceId}/ai/usage": {
    summary: "Roll up AI token usage and cost over a bounded window.",
    tags: ["AI"],
    description:
      "Token counts, cost and per-feature totals only. Prompts, note excerpts and model output are never retained, so no route can return them.",
    query: aiUsageQuerySchema,
    response: aiUsageSummarySchema,
  },
  "GET /workspaces/{workspaceId}/ai/status": {
    summary: "Whether AI features should be offered to the caller.",
    tags: ["AI"],
    description:
      "The member-facing view: enabled, provider and model only. It carries no quota, no consent flag and nothing about the stored credential.",
    response: aiStatusSchema,
  },

  // AI authoring. Part 68. These three answer `text/event-stream`, not JSON, so
  // they carry a request body and NO response schema: an SSE body is a sequence
  // of frames, not a value, and inventing a JSON schema for one would document a
  // contract no client should code against.
  "POST /workspaces/{workspaceId}/ai/summarize": {
    summary: "Summarise note text, streamed.",
    tags: ["AI"],
    description: SSE_STREAM_DESCRIPTION,
    body: aiSummarizeRequestSchema,
  },
  "POST /workspaces/{workspaceId}/ai/continue": {
    summary: "Continue writing from the text before the caret, streamed.",
    tags: ["AI"],
    description: SSE_STREAM_DESCRIPTION,
    body: aiContinueRequestSchema,
  },
  "POST /workspaces/{workspaceId}/ai/rewrite": {
    summary: "Rewrite a selection in a chosen tone, streamed.",
    tags: ["AI"],
    description: SSE_STREAM_DESCRIPTION,
    body: aiRewriteRequestSchema,
  },

  // AI structure. Part 69. Unlike the three above these answer with JSON, so
  // they document a response schema — the client gets a value to review, not a
  // stream to render.
  "POST /workspaces/{workspaceId}/ai/meeting-extraction": {
    summary: "Extract attendees, agenda, decisions and action items from a transcript.",
    tags: ["AI"],
    description:
      "Nothing is persisted: the transcript is never stored, and the extraction is computed, returned and forgotten. Applying any of it to a note is a separate, explicit action by the author. Every list is capped server-side before it is returned. An unreadable model reply is retried once and then answered with AI_OUTPUT_INVALID rather than a partial object.",
    body: aiMeetingExtractionRequestSchema,
    response: aiMeetingExtractionResultSchema,
  },
  "POST /workspaces/{workspaceId}/ai/tag-suggestions": {
    summary: "Suggest tags for a note, split into existing and new.",
    tags: ["AI"],
    description:
      "Nothing is persisted and no tag is created or attached; applying a suggestion is a separate, explicit action. The model is shown tag NAMES only and never an id: every tagId in `existing` was matched server-side against this workspace's own tag pool, so a suggestion can never name a tag from another workspace. Names the pool does not contain come back under `proposed`, which the caller must create explicitly.",
    body: aiTagSuggestionRequestSchema,
    response: aiTagSuggestionResultSchema,
  },

  // AI proofreading. Part 70. JSON as well, and the only route on this surface
  // that answers with coordinates rather than prose.
  "POST /workspaces/{workspaceId}/ai/grammar-check": {
    summary: "Check segments of note text for grammar, spelling and style problems.",
    tags: ["AI"],
    description:
      "Nothing is persisted: the segments are never stored, and the suggestions are computed, returned and forgotten. Applying one is a separate, explicit action by the author. `start` and `end` are character offsets into that segment's own `text`, counted from 0, with `end` exclusive — they are never document positions, and the caller is expected to re-validate them against its live document before applying anything. Every suggestion is re-checked server-side against the text that was sent: one addressing an unknown `segmentId`, describing an out-of-range or inverted span, or replacing text with itself is dropped from the response rather than failing it. An unreadable model reply is retried once and then answered with AI_OUTPUT_INVALID.",
    body: aiGrammarCheckRequestSchema,
    response: aiGrammarCheckResultSchema,
  },
};
