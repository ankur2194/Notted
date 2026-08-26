import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from "@nestjs/common";

import {
  authorizationDenialToHttpException,
  AuthorizationDeniedError,
} from "../../authorization/authorization.errors";
import {
  apiErrorsTotal,
  httpRouteLabel,
  metricLabel,
  statusClassLabel,
} from "../../metrics/metrics.registry";
import { StructuredLogger } from "../logging/structured-logger.service";
import { getRequestId } from "../request/request-context";

import { ApiHttpException } from "./api-http.exception";

import type { ApiErrorEnvelope } from "./api-error";
import type { ApiError } from "@notted/shared-types";
import type { Request, Response } from "express";

const ERROR_BY_STATUS: Readonly<Record<number, ApiError>> = {
  [HttpStatus.BAD_REQUEST]: { code: "BAD_REQUEST", message: "The request is invalid." },
  [HttpStatus.UNAUTHORIZED]: { code: "UNAUTHENTICATED", message: "Authentication is required." },
  [HttpStatus.FORBIDDEN]: { code: "FORBIDDEN", message: "You are not allowed to do that." },
  [HttpStatus.NOT_FOUND]: { code: "NOT_FOUND", message: "The requested resource was not found." },
  [HttpStatus.CONFLICT]: { code: "CONFLICT", message: "The request conflicts with current state." },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    code: "PAYLOAD_TOO_LARGE",
    message: "The request body is too large.",
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: "RATE_LIMITED",
    message: "Too many requests. Try again later.",
  },
  [HttpStatus.UNPROCESSABLE_ENTITY]: {
    code: "UNPROCESSABLE_ENTITY",
    message: "The request could not be processed.",
  },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "The media type is not supported.",
  },
};

/**
 * The FIRST stack frame, reduced to `file:line:col` and nothing else.
 *
 * A raw stack string must never reach a log: a frame's function name can be a
 * closure named after the value it closed over, and the `Error` message on the
 * stack's first line routinely quotes the note title, the email address or the
 * object key that caused the failure. A log line is persistence in exactly the
 * way a mailbox is, so the message line is skipped outright and the frame is
 * rebuilt from three captured groups whose charset excludes slashes, spaces,
 * quotes and parentheses. That makes it structurally incapable of carrying
 * content while still naming the file and line an engineer opens.
 */
const STACK_FRAME = /([^\s()/\\:]+):(\d+):(\d+)\)?\s*$/u;

function errorSite(exception: unknown): string | undefined {
  if (!(exception instanceof Error) || typeof exception.stack !== "string") return undefined;
  for (const line of exception.stack.split("\n")) {
    if (!/^\s*at\s/u.test(line)) continue;
    const frame = STACK_FRAME.exec(line);
    if (frame === null) return undefined;
    const [, file, row, column] = frame;
    return file === undefined || row === undefined || column === undefined
      ? undefined
      : `${file}:${row}:${column}`;
  }
  return undefined;
}

function statusForUnknownException(exception: unknown): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }

  if (typeof exception === "object" && exception !== null && "type" in exception) {
    const type = (exception as { type?: unknown }).type;
    if (type === "entity.parse.failed") {
      return HttpStatus.BAD_REQUEST;
    }
    if (type === "entity.too.large") {
      return HttpStatus.PAYLOAD_TOO_LARGE;
    }
  }

  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(rawException: unknown, host: ArgumentsHost): void {
    /*
     * A denial raised inside a handler — a service authorizing a nested
     * resource it only learns about from the request, such as a task list
     * scoped to a note id — reaches the filter as a plain Error. Translating it
     * here, with the same function the guard uses, is what keeps it a concealed
     * 404 instead of a 500 that both leaks "something broke on a resource you
     * cannot see" and pages an on-call engineer for a working access check.
     */
    const exception =
      rawException instanceof AuthorizationDeniedError
        ? authorizationDenialToHttpException(rawException)
        : rawException;
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = getRequestId(request) ?? "unavailable";
    const status = statusForUnknownException(exception);
    const fallback: ApiError =
      ERROR_BY_STATUS[status] ??
      (status >= 500
        ? { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." }
        : { code: "REQUEST_FAILED", message: "The request could not be completed." });
    const safeResponse = exception instanceof ApiHttpException ? exception.safeResponse : fallback;

    const errorType = exception instanceof Error ? exception.name : "UnknownError";
    // Log label only — it is deliberately NOT an `apiErrorsTotal` label, because
    // an error counter keyed by route is the cardinality risk the labeller
    // exists to avoid. It is also safe to compute here for an unmatched path: a
    // request that reached no route can no longer register a new label
    // (`httpRouteLabel`), so a 404 scan through this filter cannot fill the cap.
    const route = httpRouteLabel(request);
    apiErrorsTotal.inc({
      error_type: metricLabel(errorType),
      status_class: statusClassLabel(status),
    });

    if (status >= 500) {
      this.logger.failure(
        {
          requestId,
          method: request.method,
          // The bounded label, not `request.path`: a raw path carries workspace
          // and note identifiers straight into the log line.
          route,
          statusCode: status,
          errorType,
          errorSite: errorSite(exception),
          outcome: "error",
        },
        "Unhandled HTTP exception",
      );
    }

    const envelope: ApiErrorEnvelope = {
      success: false,
      error: {
        code: safeResponse.code,
        message: safeResponse.message,
        ...(safeResponse.details === undefined ? {} : { details: safeResponse.details }),
      },
      requestId,
    };

    response.status(status).json(envelope);
  }
}
