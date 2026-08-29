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
  // 415. Paired with HTTP 415 only; `UNPROCESSABLE_ENTITY` stays 422. Part 40
  // deliberately deferred this member and reused 422's code on 415 responses;
  // the Part 71-74 review round closed that follow-up so the status and the
  // code agree.
  | "UNSUPPORTED_MEDIA_TYPE"
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
  // 409. Deleting a project nulls its notes' and tasks' `project_id`, and a null
  // project is visible to the whole workspace — so deleting a RESTRICTED project
  // that still holds content would silently publish it. The caller moves or
  // deletes the content first, which makes the widening a deliberate choice.
  | "PROJECT_HAS_RESTRICTED_CONTENT"
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
  // Part 72 — branding. `ACCENT_CONTRAST_TOO_LOW` (422) is the accessibility
  // verdict on a syntactically perfect `#rrggbb` value: the colour is a valid
  // colour and simply cannot be read on the surfaces it would paint. It is its
  // own code rather than `VALIDATION_ERROR` because the remedy is "choose a
  // darker shade", which the settings form states with the measured ratio.
  | "ACCENT_CONTRAST_TOO_LOW"
  // Part 73 — custom domains. `DOMAIN_TAKEN` (409) is another workspace (or this
  // one) already holding the globally-unique hostname; the message is
  // deliberately identical for both so it cannot be used to detect a foreign
  // tenant's claim. `DOMAIN_RESERVED` (422) is a hostname this deployment
  // already answers on, which no tenant may claim. `UNTRUSTED_HOST` (421) is the
  // host-header refusal from the trusted-host middleware — a `Misdirected
  // Request`, not a missing resource, so a proxy re-resolves rather than caching
  // a negative.
  | "DOMAIN_TAKEN"
  | "DOMAIN_RESERVED"
  | "UNTRUSTED_HOST"
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
  | "AI_CREDENTIAL_REQUIRED"
  // Part 69 — structured AI output. `AI_OUTPUT_INVALID` (422) is a model that
  // produced something the response contract rejects, twice, including after
  // being shown the validation error; `AI_PROVIDER_ERROR` (502) is the provider
  // itself failing a non-streaming call. Part 68's streaming routes report the
  // second one as a stream frame instead, because by then the response is
  // already an event stream and cannot carry an envelope. Both are separate
  // from the governance refusals above: nothing an admin configures fixes them,
  // and the remedy is simply to try again.
  | "AI_OUTPUT_INVALID"
  | "AI_PROVIDER_ERROR";

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
