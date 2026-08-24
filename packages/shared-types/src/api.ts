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
  | "NOTE_SHARE_SELF_DENIED"
  // Part 62 — export lifecycle. All three map to 409/422 so `request-json.ts`
  // surfaces them through its `conflict` / `invalid` failure kinds rather than
  // the opaque `unavailable` bucket.
  | "EXPORT_EXPIRED"
  | "EXPORT_OBJECT_UNAVAILABLE"
  | "EXPORT_FORMAT_UNSUPPORTED"
  // Part 66 — webhook endpoint lifecycle. `WEBHOOK_URL_REJECTED` (422) is the
  // server-side SSRF verdict, which syntax validation cannot reach;
  // `WEBHOOK_NOT_VERIFIED` (409) refuses enabling an endpoint that has not
  // echoed the challenge; `WEBHOOK_VERIFICATION_FAILED` (422) is a challenge
  // the receiver did not echo. All three carry a specific remedy, so
  // `request-json.ts` surfaces their codes rather than a generic bucket.
  | "WEBHOOK_URL_REJECTED"
  | "WEBHOOK_NOT_VERIFIED"
  | "WEBHOOK_VERIFICATION_FAILED"
  // Part 67 — AI governance. These are the UPPER_SNAKE spelling of the
  // `AI_FAILURE_CODES` vocabulary in `ai.ts`: the same refusal appears here as
  // the envelope `code` and in `ai_usage.error_code` in its lowercase form.
  // They are minted rather than folded into `FORBIDDEN`/`CONFLICT`/
  // `RATE_LIMITED` because each one has a DIFFERENT remedy — turn the feature
  // on, configure a provider, accept the data notice, wait for the quota to
  // reset, slow down — and the client renders that remedy, not the status.
  // `AI_CREDENTIAL_REQUIRED` (422) is the configuration-write counterpart: the
  // admin must supply a new key before this write can be applied.
  | "AI_DISABLED"
  | "AI_NOT_CONFIGURED"
  | "AI_CONSENT_REQUIRED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_RATE_LIMITED"
  | "AI_CREDENTIAL_REQUIRED";

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
