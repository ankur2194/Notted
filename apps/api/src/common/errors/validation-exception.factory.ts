import { HttpStatus, type ValidationError } from "@nestjs/common";

import { ApiHttpException } from "./api-http.exception";

import type { ValidationIssue } from "./api-error";

function collectIssues(error: ValidationError, parentPath = ""): ValidationIssue[] {
  const path = parentPath === "" ? error.property : `${parentPath}.${error.property}`;
  const ownIssues = Object.entries(error.constraints ?? {}).map(
    ([code, message]): ValidationIssue => ({
      path,
      code,
      message,
    }),
  );
  const childIssues = (error.children ?? []).flatMap((child) => collectIssues(child, path));

  return [...ownIssues, ...childIssues];
}

export function validationExceptionFactory(errors: ValidationError[]): ApiHttpException {
  return new ApiHttpException(HttpStatus.BAD_REQUEST, {
    code: "VALIDATION_ERROR",
    message: "One or more request fields are invalid.",
    details: errors.flatMap((error) => collectIssues(error)),
  });
}
