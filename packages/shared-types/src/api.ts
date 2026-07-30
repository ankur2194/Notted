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
  | "CURRENT_SESSION_NOT_REMOTE";

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
