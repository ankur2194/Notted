import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from "@nestjs/common";

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
};

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

  catch(exception: unknown, host: ArgumentsHost): void {
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

    if (status >= 500) {
      this.logger.failure(
        {
          requestId,
          statusCode: status,
          errorType: exception instanceof Error ? exception.name : "UnknownError",
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
