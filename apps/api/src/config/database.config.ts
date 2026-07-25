import { Injectable, type Provider } from "@nestjs/common";

export const DATABASE_CONFIG = Symbol("DATABASE_CONFIG");

export interface DatabaseConfig {
  /**
   * Parsed {@link URL} form of the connection string. Exposed for diagnostics
   * and tests; never log `password` or include it in error messages.
   */
  readonly url: URL;
  /**
   * Raw `postgres://` connection string consumed by the `pg` driver. `pg`
   * accepts both the `postgres:` and `postgresql:` schemes; this value always
   * normalizes the scheme to `postgres:` so downstream tooling and logs are
   * consistent. The userinfo, when present, carries credentials and must be
   * treated as a secret.
   */
  readonly connectionString: string;
  readonly poolMaxConnections: number;
  readonly poolIdleTimeoutMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const INTEGER_PATTERN = /^\d+$/u;

const SUPPORTED_SCHEMES = new Set(["postgres:", "postgresql:"]);

function readInteger(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = environment[key];
  if (rawValue === undefined) {
    return fallback;
  }

  if (!INTEGER_PATTERN.test(rawValue)) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function readConnectionString(environment: Environment): { url: URL; connectionString: string } {
  const rawValue = environment.DATABASE_URL;
  if (rawValue === undefined || rawValue.trim() === "") {
    if (environment.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required when NODE_ENV=production");
    }

    return {
      url: new URL("postgres://notted:notted_dev_password@127.0.0.1:5432/notted_dev"),
      connectionString: "postgres://notted:notted_dev_password@127.0.0.1:5432/notted_dev",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error("DATABASE_URL must be a valid absolute postgres or postgresql URL");
  }

  if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }

  if (parsed.hostname === "") {
    throw new Error("DATABASE_URL must include a host");
  }

  // `URL.pathname` returns "/" for "postgres://h/p/db" — require a non-empty db name.
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ""));
  if (databaseName === "") {
    throw new Error("DATABASE_URL must include a database name in the path");
  }

  // `pg` accepts both schemes; normalize to `postgres:` for consistency so
  // downstream tooling and logs do not mix schemes.
  const connectionString =
    parsed.protocol === "postgresql:"
      ? `postgres:${rawValue.slice("postgresql:".length)}`
      : rawValue;

  return { url: parsed, connectionString };
}

export function parseDatabaseConfig(environment: Environment): DatabaseConfig {
  try {
    const { url, connectionString } = readConnectionString(environment);

    return Object.freeze({
      url,
      connectionString,
      poolMaxConnections: readInteger(environment, "DATABASE_POOL_MAX_CONNECTIONS", 10, 1, 100),
      poolIdleTimeoutMs: readInteger(
        environment,
        "DATABASE_POOL_IDLE_TIMEOUT_MS",
        30_000,
        1_000,
        600_000,
      ),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown validation error";
    throw new Error(`Invalid database configuration: ${message}`);
  }
}

@Injectable()
export class DatabaseConfigProvider {
  readonly value = parseDatabaseConfig(process.env);
}

export const databaseConfigProvider: Provider<DatabaseConfig> = {
  provide: DATABASE_CONFIG,
  inject: [DatabaseConfigProvider],
  useFactory: (provider: DatabaseConfigProvider): DatabaseConfig => provider.value,
};
