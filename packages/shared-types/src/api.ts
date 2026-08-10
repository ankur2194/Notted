import type { RequestId } from "./common";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "REQUEST_FAILED"
  | "UNPROCESSABLE_ENTITY"
  | "VALIDATION_ERROR"
  | "INTERNAL_SERVER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "CSRF_ORIGIN_INVALID"
  | "RECENT_AUTHENTICATION_REQUIRED"
  | "CURRENT_SESSION_NOT_REMOTE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENT_RESULT_UNAVAILABLE"
  | "VERSION_CONFLICT"
  | "NOTE_STATE_CONFLICT"
  | "NOTE_ANCESTOR_DELETED"
  | "NOTE_SUBTREE_ACTIVE"
  | "NOTE_HIERARCHY_INVALID"
  | "TASK_HIERARCHY_INVALID"
  | "TASK_RECURRENCE_INVALID"
  | "TAG_NAME_TAKEN"
  | "TAG_LIMIT_REACHED"
  | "ORDER_CONFLICT"
  | "FOLDER_HIERARCHY_INVALID"
  | "FOLDER_DEPTH_EXCEEDED"
  | "NOTE_SHARE_SELF_DENIED";

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ValidationIssue[];
}

export interface ApiSuccess<T> {
  readonly success: true;
  readonly data: T;
  readonly requestId: RequestId;
}

export interface ApiFailure {
  readonly success: false;
  readonly error: ApiError;
  readonly requestId: RequestId;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ValidationErrorDetails {
  readonly issues: readonly ValidationIssue[];
}
