/**
 * Stable public barrel for cross-boundary Zod schemas and inferred inputs.
 *
 * Import consumers from `@notted/shared-validators`, never package internals.
 */

export {
  createUserProfileSchema,
  updateUserProfileSchema,
  userProfileFilterSchema,
} from "./auth.schema";
export type {
  CreateUserProfileInput,
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
  projectFilterSchema,
  projectSortFieldSchema,
  projectStatusSchema,
  updateProjectSchema,
} from "./project.schema";
export type { CreateProjectInput, ProjectFilterInput, UpdateProjectInput } from "./project.schema";
export { searchModeSchema, searchQuerySchema, searchSortSchema } from "./search.schema";
export type { SearchQueryInput } from "./search.schema";
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
  updateWorkspaceSchema,
  workspaceFilterSchema,
  workspacePlanSchema,
  workspaceRoleSchema,
} from "./workspace.schema";
export type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  WorkspaceFilterInput,
} from "./workspace.schema";
