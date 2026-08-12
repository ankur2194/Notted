import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import { json, urlencoded, type Express } from "express";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { AuthRateLimitMiddleware } from "./auth/auth-rate-limit.middleware";
import { AuthService } from "./auth/auth.service";
import { BETTER_AUTH_NODE_HANDLER } from "./auth/auth.tokens";
import { PlatformOperatorService } from "./auth/platform-operator.service";
import { ApiExceptionFilter } from "./common/errors/api-exception.filter";
import { ApiHttpException } from "./common/errors/api-http.exception";
import { validationExceptionFactory } from "./common/errors/validation-exception.factory";
import { StructuredLogger } from "./common/logging/structured-logger.service";
import { RateLimitService } from "./common/rate-limit/rate-limit.service";
import { getRequestId } from "./common/request/request-context";
import { RequestContextMiddleware } from "./common/request/request-context.middleware";
import { APP_CONFIG, type AppConfig } from "./config/app.config";
import { AUTH_CONFIG, type AuthConfig } from "./config/auth.config";
import {
  BULL_BOARD_PATH,
  bullBoardRequestPolicy,
  hasSafeBullBoardQuery,
} from "./queue/bull-board-policy";
import { BullBoardService } from "./queue/bull-board.service";
import { QueueAdminRemediationService } from "./queue/queue-admin-remediation.service";
import { TrpcRootRouter } from "./trpc/trpc-root.service";
import { TRPC_PATH } from "./trpc/trpc.router";

import type { NestExpressApplication } from "@nestjs/platform-express";
import type { IncomingMessage, ServerResponse } from "node:http";

export async function createApplication(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: false,
    bodyParser: false,
    bufferLogs: true,
    logger: false,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  const authConfig = app.get<AuthConfig>(AUTH_CONFIG);
  const logger = app.get(StructuredLogger);
  const requestContext = app.get(RequestContextMiddleware);
  const authRateLimit = app.get(AuthRateLimitMiddleware);
  const authService = app.get(AuthService);
  const platformOperator = app.get(PlatformOperatorService);
  const rateLimit = app.get(RateLimitService);
  const bullBoard = app.get(BullBoardService);
  const queueAdmin = app.get(QueueAdminRemediationService);
  const rootTrpc = app.get(TrpcRootRouter);
  const authHandler = app.get<
    ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | null
  >(BETTER_AUTH_NODE_HANDLER);
  const express = app.getHttpAdapter().getInstance() as Express;

  app.useLogger(logger);
  express.set("trust proxy", config.trustProxyHops === 0 ? false : config.trustProxyHops);

  app.use(requestContext.use.bind(requestContext));
  app.use(helmet());
  app.use(compression());
  const corsOrigins = new Set(authConfig.trustedOrigins);
  app.enableCors({
    origin: (origin, callback) => {
      callback(null, origin === undefined || corsOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    exposedHeaders: [
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Retry-After",
      "X-Request-Id",
    ],
    maxAge: 600,
  });
  // Better Auth owns this unversioned path. It must receive the raw stream
  // before Express body parsing; request IDs, headers, compression, CORS and
  // the sensitive endpoint limiter are already active.
  if (authHandler !== null) {
    express.use(authConfig.basePath, (request, response, next) => {
      const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
      if (!stateChanging) {
        next();
        return;
      }
      const origin = request.header("origin");
      if (origin !== undefined && corsOrigins.has(origin)) {
        next();
        return;
      }
      response.status(403).json({
        success: false,
        error: { code: "CSRF_ORIGIN_INVALID", message: "The request origin is not allowed." },
        requestId: response.getHeader("X-Request-Id") ?? "unknown",
      });
    });
    express.use(authConfig.basePath, authRateLimit.use.bind(authRateLimit));
    express.use(authConfig.basePath, (request, response) => {
      void authHandler(request, response).catch(() => {
        logger.failure({ component: "auth", outcome: "error" }, "Auth handler failed");
        if (!response.headersSent) {
          response.status(503).json({
            success: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "Authentication is unavailable." },
            requestId: response.getHeader("X-Request-Id") ?? "unknown",
          });
        }
      });
    });
  }
  app.use(json({ limit: config.requestBodyLimitBytes, strict: true }));
  app.use(
    urlencoded({
      extended: false,
      limit: config.requestBodyLimitBytes,
      parameterLimit: 1_000,
    }),
  );
  // This literal, unversioned operational route is mounted before Nest's
  // `/api/v1` prefix. Authentication is performed for every document, asset,
  // and API request. Only the board operations required by Part 50 are
  // allow-listed; mutations require trusted Origin and a committed audit row
  // before Bull Board can touch Redis.
  express.use(
    BULL_BOARD_PATH,
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
    (request, response, next) => {
      void (async () => {
        const operator = await platformOperator.requireOperator(request);
        rateLimit.enforce(request, response);

        const policy = bullBoardRequestPolicy(request.method, request.path);
        if (policy === null || (policy.kind === "read" && !hasSafeBullBoardQuery(request.query))) {
          response.status(404).json({
            success: false,
            error: { code: "NOT_FOUND", message: "The requested resource was not found." },
            requestId: response.getHeader("X-Request-Id") ?? "unknown",
          });
          return;
        }
        if (policy.kind === "mutation") {
          authService.assertTrustedMutationOrigin(request);
          const requestId = getRequestId(request);
          if (requestId === undefined || policy.audit.jobId === undefined) {
            throw new Error("QUEUE_ADMIN_REQUEST_INVALID");
          }
          await queueAdmin.retry({
            queueName: policy.audit.queueName,
            jobId: policy.audit.jobId,
            requestId,
            operator,
          });
          response.status(200).json({ status: "retried" });
          return;
        }

        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Robots-Tag", "noindex, nofollow");
        bullBoard.middleware()(request, response, next);
      })().catch((error: unknown) => {
        if (error instanceof ApiHttpException) {
          response.status(error.getStatus()).json({
            success: false,
            error: error.safeResponse,
            requestId: response.getHeader("X-Request-Id") ?? "unknown",
          });
          return;
        }
        response.status(503).json({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Administrative access is unavailable." },
          requestId: response.getHeader("X-Request-Id") ?? "unknown",
        });
      });
    },
  );
  // Resolve valid cookie sessions before Nest's global rate-limit guard. A
  // forged header can never select the authenticated tier; only this trusted
  // Better Auth lookup installs the principal. Redis errors fail closed.
  express.use("/api/v1", (request, response, next) => {
    void authService
      .authenticate(request)
      .then(() => next())
      .catch(() => {
        response.status(503).json({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Authentication is unavailable." },
          requestId: response.getHeader("X-Request-Id") ?? "unknown",
        });
      });
  });
  express.use(
    TRPC_PATH,
    (request, response, next) => {
      try {
        rateLimit.enforce(request, response);
        next();
      } catch (error: unknown) {
        if (error instanceof ApiHttpException) {
          response.status(error.getStatus()).json({
            success: false,
            error: error.safeResponse,
            requestId: response.getHeader("X-Request-Id") ?? "unknown",
          });
          return;
        }
        next(error);
      }
    },
    createExpressMiddleware({
      router: rootTrpc.router,
      createContext: ({ req }) => rootTrpc.createContext(req),
    }),
  );
  app.setGlobalPrefix("api/v1", {
    exclude: ["health/live", "health/ready"],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: false,
      validationError: {
        target: false,
        value: false,
      },
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();

  return app;
}

export async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.apiPort, config.apiHost);
}

if (require.main === module) {
  void bootstrap();
}
