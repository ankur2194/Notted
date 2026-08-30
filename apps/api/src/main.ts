import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import { json, urlencoded, type Express } from "express";
import helmet from "helmet";

import { ApiKeyAuthService, getApiKeyActor } from "./api-keys";
import { AppModule } from "./app.module";
import { AuthRateLimitMiddleware } from "./auth/auth-rate-limit.middleware";
import { AuthService } from "./auth/auth.service";
import { BETTER_AUTH_NODE_HANDLER } from "./auth/auth.tokens";
import { CsrfOriginMiddleware } from "./auth/csrf-origin.middleware";
import { PlatformOperatorService } from "./auth/platform-operator.service";
import { ApiExceptionFilter } from "./common/errors/api-exception.filter";
import { ApiHttpException } from "./common/errors/api-http.exception";
import { validationExceptionFactory } from "./common/errors/validation-exception.factory";
import { writeApiFailure } from "./common/errors/write-api-failure";
import { StructuredLogger } from "./common/logging/structured-logger.service";
import { RateLimitService } from "./common/rate-limit/rate-limit.service";
import { getRequestId } from "./common/request/request-context";
import { RequestContextMiddleware } from "./common/request/request-context.middleware";
import { VerifiedHostsService } from "./common/verified-hosts.service";
import { APP_CONFIG, type AppConfig } from "./config/app.config";
import { AUTH_CONFIG, type AuthConfig } from "./config/auth.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "./config/features.config";
import { REALTIME_CONFIG, type RealtimeConfig } from "./config/realtime.config";
import { TrustedHostMiddleware } from "./domains/trusted-host.middleware";
import {
  BULL_BOARD_PATH,
  bullBoardRequestPolicy,
  hasSafeBullBoardQuery,
} from "./queue/bull-board-policy";
import { BullBoardService } from "./queue/bull-board.service";
import { QueueAdminRemediationService } from "./queue/queue-admin-remediation.service";
import { RealtimeRateLimitService } from "./realtime/realtime-rate-limit.service";
import { RealtimeRedisAdapterService } from "./realtime/realtime-redis-adapter.service";
import { RealtimeSocketAdapter } from "./realtime/realtime-socket.adapter";
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
  const trustedHost = app.get(TrustedHostMiddleware);
  const verifiedHosts = app.get(VerifiedHostsService);
  const authRateLimit = app.get(AuthRateLimitMiddleware);
  const authService = app.get(AuthService);
  const csrfOrigin = app.get(CsrfOriginMiddleware);
  const apiKeyAuth = app.get(ApiKeyAuthService);
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
  const realtimeRedis = app.get(RealtimeRedisAdapterService);
  await realtimeRedis.initialize();
  app.useWebSocketAdapter(
    new RealtimeSocketAdapter(
      app,
      app.get<FeaturesConfig>(FEATURES_CONFIG),
      app.get<RealtimeConfig>(REALTIME_CONFIG),
      authConfig,
      config,
      app.get(RealtimeRateLimitService),
      realtimeRedis,
    ),
  );
  express.set("trust proxy", config.trustProxyHops === 0 ? false : config.trustProxyHops);

  app.use(requestContext.use.bind(requestContext));
  // Part 74. FIRST after the request id, and deliberately ahead of the Part 73
  // trusted-host check below: helmet reads nothing host-derived, so putting it
  // first costs nothing and is the only way a refusal — a 421 from
  // `TrustedHostMiddleware`, a CORS rejection — carries the security headers
  // too. A response without them is still a response.
  //
  // Explicit rather than `helmet()`'s defaults, because the API serves
  // JSON, files and downloads — never a document a browser should execute.
  //
  //   * `default-src 'none'` with nothing added: an API response has no
  //     legitimate subresource of any kind, so the strictest possible policy is
  //     also the correct one. Bull Board is the single HTML surface and
  //     overrides this below with its own directives.
  //   * HSTS is PRODUCTION ONLY. Sending it from `http://localhost:3001` would
  //     pin the developer's browser to HTTPS for localhost — a durable,
  //     hard-to-clear break of every other local project on that host.
  //   * CORP `same-origin` is the safe default; the attachment and export
  //     routes already downgrade themselves to `same-site` where the web app
  //     must read the bytes cross-origin.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "no-referrer" },
      hsts:
        config.nodeEnv === "production"
          ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
          : false,
    }),
  );
  // Part 73. After helmet (see above) and BEFORE everything that reads the
  // host: CORS, the Better Auth handler, and every route. No-op unless
  // `CUSTOM_DOMAINS_ENABLED`.
  app.use(trustedHost.use.bind(trustedHost));
  app.use(compression());
  const corsOrigins = new Set(authConfig.trustedOrigins);
  // Part 73. The configured origins ALWAYS pass — `isTrustedOriginSync` answers
  // for them from a set built at boot, with no I/O and no dependency on the
  // database — and a verified tenant origin additionally passes once the
  // trusted-host middleware above has seen it. The `Set` stays as the primary
  // answer so this callback behaves identically when custom domains are off.
  const isTrustedOrigin = (origin: string): boolean =>
    corsOrigins.has(origin) || verifiedHosts.isTrustedOriginSync(origin);
  app.enableCors({
    origin: (origin, callback) => {
      callback(null, origin === undefined || isTrustedOrigin(origin));
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
      // Part 74. Better Auth resolves the client IP itself and, by default,
      // believes any `x-forwarded-for` it is handed. Overwrite one private
      // header — the ONLY one it is configured to read — with Express's own
      // `request.ip`, which already honours `trust proxy`. Unconditional on
      // purpose: an inbound value for this name must never survive.
      request.headers["x-notted-client-ip"] =
        request.ip ?? request.socket.remoteAddress ?? "unknown";
      const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
      if (!stateChanging) {
        next();
        return;
      }
      /*
       * THE BODY-SIZE LIMIT FOR `/api/auth/**`, and it has to live here.
       *
       * `json({ limit })` below is mounted AFTER this handler, and Better Auth
       * reads the raw stream itself (see the comment above the mount), so it
       * never saw these requests — `docs/API.md` promised a 413 that the auth
       * surface did not deliver. Moving `json()` above the mount would work
       * today only because `better-call` happens to fall back to re-serializing
       * `req.body` once Express has drained the stream, which is a private
       * branch of a transitive dependency and not a contract; it would also send
       * malformed auth JSON to Express's default HTML error page instead of this
       * envelope, because this mount is raw Express outside the Nest filter.
       *
       * AN ABSENT `content-length` IS REFUSED, not waved through. `better-call`
       * sets `length = Number(content_length)`, so with no header that is `NaN`
       * and its `size > length` guard is always false — a chunked body would
       * stream with no cap at all. Counting bytes here instead would put the
       * stream into flowing mode and steal it from the handler.
       */
      const declaredLength = Number(request.headers["content-length"]);
      if (!Number.isFinite(declaredLength) || declaredLength > config.requestBodyLimitBytes) {
        writeApiFailure(response, 413, {
          code: "PAYLOAD_TOO_LARGE",
          message: "The request body is too large.",
        });
        return;
      }
      const origin = request.header("origin");
      if (origin !== undefined && isTrustedOrigin(origin)) {
        next();
        return;
      }
      writeApiFailure(response, 403, {
        code: "CSRF_ORIGIN_INVALID",
        message: "The request origin is not allowed.",
      });
    });
    express.use(authConfig.basePath, authRateLimit.use.bind(authRateLimit));
    express.use(authConfig.basePath, (request, response) => {
      void authHandler(request, response).catch(() => {
        logger.failure({ component: "auth", outcome: "error" }, "Auth handler failed");
        if (!response.headersSent) {
          writeApiFailure(response, 503, {
            code: "SERVICE_UNAVAILABLE",
            message: "Authentication is unavailable.",
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
          writeApiFailure(response, 404, {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
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
          writeApiFailure(response, error.getStatus(), error.safeResponse);
          return;
        }
        writeApiFailure(response, 503, {
          code: "SERVICE_UNAVAILABLE",
          message: "Administrative access is unavailable.",
        });
      });
    },
  );
  // Resolve credentials before Nest's global rate-limit guard. A forged header
  // can never select a privileged tier; only these trusted lookups install a
  // principal. Redis errors fail closed.
  //
  // THE ORDER BELOW IS LOAD-BEARING.
  //   1. `ApiKeyAuthService.authenticate` installs, in this order,
  //      `setApiKeyActor` -> `setTrustedPrincipal({ kind: "api-key" })` ->
  //      `setAuthPrincipal(synthetic creator principal)`. The trusted principal
  //      must exist before `RateLimitGuard` runs, which is why this middleware
  //      sits ahead of the Nest pipeline rather than inside it.
  //   2. The fallback `AuthService.authenticate` then memo-returns on the
  //      already-installed synthetic principal (`getAuthPrincipal` early
  //      return) BEFORE reaching its own `setTrustedPrincipal({ kind: "user" })`
  //      line, so the api-key tier can never be overwritten by the user tier.
  express.use("/api/v1", (request, response, next) => {
    void (async () => {
      // API-key credentials are refused on tRPC by the guard mounted at
      // `TRPC_PATH` below, which asks whether an api-key actor was installed
      // rather than re-parsing the request line here. See the comment there.
      if (!(await apiKeyAuth.authenticate(request))) {
        await authService.authenticate(request);
      }
      next();
    })().catch((error: unknown) => {
      // An invalid API key raises a real 401. Collapsing every error into 503
      // would report that — and every other credential failure — as an outage.
      if (error instanceof ApiHttpException) {
        writeApiFailure(response, error.getStatus(), error.safeResponse);
        return;
      }
      writeApiFailure(response, 503, {
        code: "SERVICE_UNAVAILABLE",
        message: "Authentication is unavailable.",
      });
    });
  });
  // Part 74. AFTER the credential middleware above (it needs to know whether an
  // API-key actor was installed) and BEFORE tRPC and the Nest pipeline, so one
  // default-deny Origin check covers every mutating cookie-authenticated route
  // on `/api/v1` — including any added later that forgets the manual call.
  express.use("/api/v1", csrfOrigin.use.bind(csrfOrigin));
  express.use(
    TRPC_PATH,
    (request, response, next) => {
      // tRPC is the first-party transport, not a compatibility promise: API-key
      // credentials are rejected rather than silently ignored.
      //
      // THE QUESTION IS ASKED OF THE PIPELINE, NOT OF THE REQUEST LINE. The
      // credential middleware above has already run, and only
      // `ApiKeyAuthService.authenticate` installs the actor, so this fact cannot
      // drift from the parser that produces it. The string comparison this
      // replaced could be walked past two different ways: its scheme match was
      // case-sensitive and single-space while `bearerSecret` lowercases and
      // trims, and its `baseUrl + path` compare was case-sensitive while Express
      // matches this very mount case-insensitively.
      //
      // THIS GUARD IS LOAD-BEARING. tRPC is raw Express middleware outside the
      // Nest pipeline, so `ApiKeyRouteGuard` never runs here, and
      // `createTrpcContext` reads only `getAuthPrincipal` — never the actor. A
      // key that slipped past would execute every procedure as its CREATOR,
      // with the creator's full workspace role and the key's scopes ignored.
      if (getApiKeyActor(request) !== undefined) {
        writeApiFailure(response, 403, {
          code: "FORBIDDEN",
          message: "You are not allowed to do that.",
        });
        return;
      }
      try {
        rateLimit.enforce(request, response);
        next();
      } catch (error: unknown) {
        if (error instanceof ApiHttpException) {
          writeApiFailure(response, error.getStatus(), error.safeResponse);
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
    // Operational routes, deliberately unversioned: an orchestrator's probe and
    // a Prometheus scraper are configured by an operator, not by a client that
    // negotiates an API version. `/metrics` authenticates with its own bearer
    // token and answers 404 when `METRICS_TOKEN` is unset (Part 78).
    exclude: ["health/live", "health/ready", "metrics"],
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
