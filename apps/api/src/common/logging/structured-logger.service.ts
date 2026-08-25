import { Inject, Injectable, type LoggerService } from "@nestjs/common";
import pino, { type Logger } from "pino";

import { APP_CONFIG, type AppConfig } from "../../config/app.config";

type LogMetadata = Readonly<Record<string, boolean | number | string | undefined>>;

@Injectable()
export class StructuredLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.logger = pino({
      level: config.logLevel,
      base: {
        service: "notted-api",
        environment: config.nodeEnv,
      },
      redact: {
        paths: [
          "authorization",
          "cookie",
          "password",
          "email",
          "recipient",
          "secret",
          "token",
          "url",
          "actionUrl",
          "encryptedContext",
          "providerMessageId",
          "code",
          "backupCodes",
          "recoveryCodes",
          "totpURI",
          "credentialID",
          "credentialId",
          "publicKey",
          "clientSecret",
          "accessToken",
          "refreshToken",
          "idToken",
          "apiKey",
          "api_key",
          '["x-api-key"]',
          "signature",
          '["set-cookie"]',
          "privateKey",
          "webhookSecret",
          "secretKey",
          "accessKey",
          "connectionString",
          "dsn",
          "*.authorization",
          "*.cookie",
          "*.password",
          "*.email",
          "*.recipient",
          "*.secret",
          "*.token",
          "*.url",
          "*.actionUrl",
          "*.encryptedContext",
          "*.providerMessageId",
          "*.code",
          "*.backupCodes",
          "*.recoveryCodes",
          "*.totpURI",
          "*.credentialID",
          "*.credentialId",
          "*.publicKey",
          "*.clientSecret",
          "*.accessToken",
          "*.refreshToken",
          "*.idToken",
          "*.apiKey",
          "*.api_key",
          '*["x-api-key"]',
          "*.signature",
          '*["set-cookie"]',
          "*.privateKey",
          "*.webhookSecret",
          "*.secretKey",
          "*.accessKey",
          "*.connectionString",
          "*.dsn",
          // `req.*`/`res.*`/`err.*`/`error.*`/`request.*` are unreachable through
          // the typed `LogMetadata` (scalars only, deliberately, so callers
          // cannot dump objects into a log line). They defend the untyped call
          // sites — pino serializers and Nest's `LoggerService` overloads,
          // which hand pino whole request/response/error objects.
          "req.headers",
          "res.headers",
          "response.headers",
          "err.config",
          "err.request",
          "err.response",
          "err.headers",
          "error.config",
          "error.request",
          "error.response",

          "request.headers",
          "request.body",
        ],
        censor: "[REDACTED]",
      },
    });
  }

  log(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.info(this.metadata(optionalParameters), this.safeMessage(message));
  }

  error(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.error(this.metadata(optionalParameters), this.safeMessage(message));
  }

  warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.warn(this.metadata(optionalParameters), this.safeMessage(message));
  }

  debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.debug(this.metadata(optionalParameters), this.safeMessage(message));
  }

  verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.trace(this.metadata(optionalParameters), this.safeMessage(message));
  }

  fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.fatal(this.metadata(optionalParameters), this.safeMessage(message));
  }

  info(metadata: LogMetadata, message: string): void {
    this.logger.info(metadata, message);
  }

  /**
   * The warn-level sibling of `info`/`failure`.
   *
   * It exists because `warn` above implements Nest's `LoggerService`, whose
   * signature is (message, ...optional): calling that with a metadata object
   * first silently discarded every field and logged the literal string
   * "Structured log event". Structured callers get their own name so the two
   * shapes can never be confused again.
   */
  warning(metadata: LogMetadata, message: string): void {
    this.logger.warn(metadata, message);
  }

  failure(metadata: LogMetadata, message: string): void {
    this.logger.error(metadata, message);
  }

  private metadata(optionalParameters: readonly unknown[]): LogMetadata {
    const lastParameter = optionalParameters.at(-1);
    const context = typeof lastParameter === "string" ? lastParameter : undefined;
    return context === undefined ? {} : { context };
  }

  private safeMessage(message: unknown): string {
    if (typeof message === "string") {
      return message;
    }

    if (typeof message === "number" || typeof message === "boolean") {
      return String(message);
    }

    if (message instanceof Error) {
      return message.name;
    }

    return "Structured log event";
  }
}
