import { Inject, Injectable, type LoggerService } from "@nestjs/common";
import pino, { type Logger } from "pino";

import { APP_CONFIG, type AppConfig } from "../../config/app.config";

type LogMetadata = Readonly<Record<string, boolean | number | string | undefined>>;

/*
 * ONE list, two spellings derived from it. These were 33 keys written out by
 * hand and then written out again with a nesting prefix, with nothing checking
 * that the halves agreed — so adding `otpSecret` to the first half only would
 * have redacted it at the top level and leaked it one object deep, silently.
 *
 * The nested spelling for the two bracket-notation keys changes from
 * `*["x-api-key"]` to `*.["x-api-key"]`. Verified equivalent against the
 * installed pino: both forms, and a bare `*.x-api-key`, redact the same nested
 * value, so the uniform prefix costs nothing and a special case for it would be
 * a branch no test could tell from the other.
 */
export const SENSITIVE_KEYS = [
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
] as const;

/*
 * `req.*`/`res.*`/`err.*`/`error.*`/`request.*` are unreachable through the
 * typed `LogMetadata` (scalars only, deliberately, so callers cannot dump
 * objects into a log line). They defend the untyped call sites — pino
 * serializers and Nest's `LoggerService` overloads, which hand pino whole
 * request/response/error objects.
 */
const UNTYPED_CALLSITE_PATHS = [
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
] as const;


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
          ...SENSITIVE_KEYS,
          ...SENSITIVE_KEYS.map((key) => `*.${key}`),
          ...UNTYPED_CALLSITE_PATHS,
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
