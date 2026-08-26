import { randomUUID } from "node:crypto";

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";

import {
  httpRequestDurationSeconds,
  httpRequestsInFlight,
  httpRouteLabel,
  metricLabel,
  statusClassLabel,
} from "../../metrics/metrics.registry";
import { StructuredLogger } from "../logging/structured-logger.service";

import {
  REQUEST_IP_MAX_LENGTH,
  REQUEST_USER_AGENT_MAX_LENGTH,
  runWithRequestContext,
  setRequestId,
} from "./request-context";

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
    // Downstream raw integrations (including Better Auth before body parsing)
    // receive the same validated/generated correlation ID.
    request.headers["x-request-id"] = requestId;
    response.setHeader("X-Request-Id", requestId);

    // Part 78 mounts HTTP metrics HERE rather than in a Nest interceptor,
    // because this middleware is `app.use`'d FIRST (`main.ts`) and therefore
    // sees tRPC, Better Auth and Bull Board — none of which pass through Nest's
    // interceptor chain — and it already holds the duration the histogram wants.
    httpRequestsInFlight.inc();
    // `close`, not `finish`: a client that aborts mid-response never emits
    // `finish`, and an in-flight gauge that only ever counts up is worse than no
    // gauge. `close` fires on both paths.
    response.once("close", () => {
      httpRequestsInFlight.dec();
    });

    response.once("finish", () => {
      const statusCode = response.statusCode;
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      httpRequestDurationSeconds.observe(
        {
          method: metricLabel(request.method, 10),
          route: httpRouteLabel(request),
          // The CLASS, never the raw status: 40-odd statuses multiplied by the
          // route label would be 40× the series for a distinction no alert makes.
          status_class: statusClassLabel(statusCode),
        },
        durationMs / 1_000,
      );
      this.logger.info(
        {
          requestId,
          method: request.method,
          // `originalUrl`, not `path`: Express strips the mount prefix from
          // `req.url` (and therefore from the `req.path` getter) when it
          // dispatches into an `app.use(prefix, handler)` mount and only
          // restores it in the `next()` callback a terminating sub-handler
          // never calls — so this line used to log `/sign-up/email` for a
          // request to `/api/auth/sign-up/email`. The query string is cut
          // because it carries tokens and search terms.
          path: request.originalUrl.split("?")[0] ?? request.path,
          statusCode,
          durationMs,
          outcome: statusCode >= 500 ? "error" : statusCode >= 400 ? "denied" : "success",
        },
        "HTTP request completed",
      );
    });

    // Part 71: the audit-facing request facts live in an AsyncLocalStorage
    // entered HERE, so every downstream writer — REST, tRPC and Better Auth all
    // run behind this one `app.use` — can record the caller's address and agent
    // without threading them through a single service signature. Both are
    // truncated at the boundary to their column widths.
    runWithRequestContext(
      {
        requestId,
        ipAddress: request.ip?.slice(0, REQUEST_IP_MAX_LENGTH) ?? null,
        // `||` and not `??`: an empty User-Agent header is "absent", not "".
        userAgent: request.header("user-agent")?.slice(0, REQUEST_USER_AGENT_MAX_LENGTH) || null,
      },
      next,
    );
  }
}
