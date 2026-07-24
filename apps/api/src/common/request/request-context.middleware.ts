import { randomUUID } from "node:crypto";

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";

import { StructuredLogger } from "../logging/structured-logger.service";

import { setRequestId } from "./request-context";

import type { NextFunction, Request, Response } from "express";

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function selectRequestId(
  incomingRequestId: string | undefined,
  generateRequestId: () => string = randomUUID,
): string {
  if (
    incomingRequestId !== undefined &&
    incomingRequestId.length <= 36 &&
    REQUEST_ID_PATTERN.test(incomingRequestId)
  ) {
    return incomingRequestId.toLowerCase();
  }

  return generateRequestId();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(StructuredLogger) private readonly logger: StructuredLogger) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = selectRequestId(request.header("x-request-id"));
    const startedAt = performance.now();

    setRequestId(request, requestId);
    response.setHeader("X-Request-Id", requestId);

    response.once("finish", () => {
      const statusCode = response.statusCode;
      this.logger.info(
        {
          requestId,
          method: request.method,
          path: request.path,
          statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          outcome: statusCode >= 500 ? "error" : statusCode >= 400 ? "denied" : "success",
        },
        "HTTP request completed",
      );
    });

    next();
  }
}
