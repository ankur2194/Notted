import type { ApiErrorCode, ApiFailure, ValidationIssue } from "@notted/shared-types";

export type ApiErrorEnvelope = ApiFailure;

export interface SafeHttpExceptionResponse {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ValidationIssue[];
}

export type { ValidationIssue };
