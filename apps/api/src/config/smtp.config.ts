import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readHost,
  readInteger,
  readOptionalString,
  readString,
  wrapConfigError,
} from "./environment-readers";

export const SMTP_CONFIG = Symbol("SMTP_CONFIG");

export interface SmtpConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTls: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  readonly connectionTimeoutMs: number;
  readonly greetingTimeoutMs: number;
  readonly socketTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly startupRetryAttempts: number;
  readonly retryDelayMs: number;
}

function readFromAddress(environment: Environment, required: boolean): string {
  const value = readString(
    environment,
    "EMAIL_FROM",
    required ? undefined : "noreply@notted.local",
  ).trim();
  if (value.includes("\r") || value.includes("\n") || value.length > 320) {
    throw new Error("EMAIL_FROM must be a valid mailbox");
  }

  const displayMailbox = value.match(/^([^<>\r\n]+?)\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/u);
  const address = displayMailbox?.[2] ?? value;
  if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/u.test(address)) {
    throw new Error("EMAIL_FROM must be a valid mailbox");
  }

  return value;
}

export function parseSmtpConfig(environment: Environment): SmtpConfig {
  try {
    const enabled = readBoolean(environment, "FEATURE_EMAIL_ENABLED", true);
    const productionRequired = enabled && environment.NODE_ENV === "production";
    const user = readOptionalString(environment, "EMAIL_SMTP_USER");
    const password = readOptionalString(environment, "EMAIL_SMTP_PASSWORD");
    if ((user === undefined) !== (password === undefined)) {
      throw new Error("EMAIL_SMTP_USER and EMAIL_SMTP_PASSWORD must be set together");
    }
    if (productionRequired && user === undefined) {
      throw new Error(
        "EMAIL_SMTP_USER and EMAIL_SMTP_PASSWORD are required when email is enabled in production",
      );
    }
    if (productionRequired && password !== undefined && Buffer.byteLength(password, "utf8") < 16) {
      throw new Error("EMAIL_SMTP_PASSWORD must be at least 16 bytes in production");
    }
    const secure = readBoolean(environment, "EMAIL_SMTP_SECURE", false);
    const requireTls = readBoolean(environment, "EMAIL_SMTP_REQUIRE_TLS", productionRequired);
    if (productionRequired && !secure && !requireTls) {
      throw new Error("production SMTP must require TLS");
    }

    return Object.freeze({
      enabled,
      host: readHost(environment, "EMAIL_SMTP_HOST", productionRequired ? undefined : "127.0.0.1"),
      port: readInteger(environment, "EMAIL_SMTP_PORT", 1_025, 1, 65_535),
      secure,
      requireTls,
      user,
      password,
      from: readFromAddress(environment, productionRequired),
      connectionTimeoutMs: readInteger(
        environment,
        "EMAIL_SMTP_CONNECTION_TIMEOUT_MS",
        3_000,
        100,
        60_000,
      ),
      greetingTimeoutMs: readInteger(
        environment,
        "EMAIL_SMTP_GREETING_TIMEOUT_MS",
        3_000,
        100,
        60_000,
      ),
      socketTimeoutMs: readInteger(
        environment,
        "EMAIL_SMTP_SOCKET_TIMEOUT_MS",
        5_000,
        100,
        120_000,
      ),
      readinessTimeoutMs: readInteger(
        environment,
        "EMAIL_SMTP_READINESS_TIMEOUT_MS",
        2_500,
        100,
        30_000,
      ),
      startupRetryAttempts: readInteger(
        environment,
        "EMAIL_SMTP_STARTUP_RETRY_ATTEMPTS",
        environment.NODE_ENV === "test" ? 1 : 3,
        1,
        10,
      ),
      retryDelayMs: readInteger(environment, "EMAIL_SMTP_RETRY_DELAY_MS", 100, 10, 10_000),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid SMTP configuration", error);
  }
}

@Injectable()
export class SmtpConfigProvider {
  readonly value = parseSmtpConfig(process.env);
}

export const smtpConfigProvider: Provider<SmtpConfig> = {
  provide: SMTP_CONFIG,
  inject: [SmtpConfigProvider],
  useFactory: (provider: SmtpConfigProvider): SmtpConfig => provider.value,
};
