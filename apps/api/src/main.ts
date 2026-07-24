import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import compression from "compression";
import { json, urlencoded, type Express } from "express";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./common/errors/api-exception.filter";
import { validationExceptionFactory } from "./common/errors/validation-exception.factory";
import { StructuredLogger } from "./common/logging/structured-logger.service";
import { RequestContextMiddleware } from "./common/request/request-context.middleware";
import { APP_CONFIG, type AppConfig } from "./config/app.config";

import type { NestExpressApplication } from "@nestjs/platform-express";

export async function createApplication(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: false,
    bodyParser: false,
    bufferLogs: true,
    logger: false,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(StructuredLogger);
  const requestContext = app.get(RequestContextMiddleware);
  const express = app.getHttpAdapter().getInstance() as Express;

  app.useLogger(logger);
  express.set("trust proxy", config.trustProxyHops === 0 ? false : config.trustProxyHops);

  app.use(requestContext.use.bind(requestContext));
  app.use(helmet());
  app.use(compression());
  app.use(json({ limit: config.requestBodyLimitBytes, strict: true }));
  app.use(
    urlencoded({
      extended: false,
      limit: config.requestBodyLimitBytes,
      parameterLimit: 1_000,
    }),
  );
  app.enableCors({
    origin: (origin, callback) => {
      callback(null, origin === undefined || origin === config.appUrl.origin);
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
