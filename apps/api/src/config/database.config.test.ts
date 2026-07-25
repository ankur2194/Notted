import { describe, expect, it } from "vitest";

import { parseDatabaseConfig } from "./database.config";

const DEV_DEFAULT_CONNECTION_STRING =
  "postgres://notted:notted_dev_password@127.0.0.1:5432/notted_dev";

describe("parseDatabaseConfig", () => {
  it("provides the dev default connection string when DATABASE_URL is unset", () => {
    const config = parseDatabaseConfig({});

    expect(config.connectionString).toBe(DEV_DEFAULT_CONNECTION_STRING);
    expect(config.url.hostname).toBe("127.0.0.1");
    expect(config.url.pathname).toBe("/notted_dev");
    expect(config.poolMaxConnections).toBe(10);
    expect(config.poolIdleTimeoutMs).toBe(30_000);
  });

  it("accepts an explicit postgres:// connection string", () => {
    const config = parseDatabaseConfig({
      DATABASE_URL: "postgres://user:secret@db.example:5433/app_db",
      DATABASE_POOL_MAX_CONNECTIONS: "25",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "45000",
    });

    expect(config.connectionString).toBe("postgres://user:secret@db.example:5433/app_db");
    expect(config.url.hostname).toBe("db.example");
    expect(config.url.pathname).toBe("/app_db");
    expect(config.poolMaxConnections).toBe(25);
    expect(config.poolIdleTimeoutMs).toBe(45_000);
  });

  it("normalizes the postgresql: scheme to postgres: in the connection string", () => {
    const config = parseDatabaseConfig({
      DATABASE_URL: "postgresql://user:secret@db.example:5433/app_db",
    });

    expect(config.connectionString).toBe("postgres://user:secret@db.example:5433/app_db");
    // The diagnostic URL keeps the original scheme so callers can see what was supplied.
    expect(config.url.protocol).toBe("postgresql:");
  });

  it.each([
    [{ NODE_ENV: "production" }, "DATABASE_URL is required"],
    [{ DATABASE_URL: "postgres:///app_db" }, "must include a host"],
    [{ DATABASE_URL: "postgres://u:p@h:5/" }, "must include a database name"],
    [{ DATABASE_URL: "postgres://u:p@h:5" }, "must include a database name"],
    [{ DATABASE_URL: "mysql://u:p@h:5/db" }, "must use the postgres or postgresql"],
    [{ DATABASE_URL: "not-a-url" }, "must be a valid absolute postgres"],
    [{ DATABASE_URL: "", NODE_ENV: "production" }, "DATABASE_URL is required"],
  ])("rejects invalid DATABASE_URL values %#", (environment, expectedMessage) => {
    expect(() => parseDatabaseConfig(environment)).toThrowError(expectedMessage);
  });

  it.each([
    [{ DATABASE_POOL_MAX_CONNECTIONS: "0" }, "must be an integer between 1 and 100"],
    [{ DATABASE_POOL_MAX_CONNECTIONS: "101" }, "must be an integer between 1 and 100"],
    [{ DATABASE_POOL_MAX_CONNECTIONS: "abc" }, "must be an integer between 1 and 100"],
    [{ DATABASE_POOL_IDLE_TIMEOUT_MS: "999" }, "must be an integer between 1000 and 600000"],
    [{ DATABASE_POOL_IDLE_TIMEOUT_MS: "600001" }, "must be an integer between 1000 and 600000"],
  ])("rejects out-of-range integer settings %#", (environment, expectedMessage) => {
    expect(() => parseDatabaseConfig(environment)).toThrowError(expectedMessage);
  });

  it("does not include the password in the wrapped error message", () => {
    const secret = "super-secret-password";
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: `postgres://user:${secret}@db.example:5432/` }),
    ).toThrowError("Invalid database configuration: DATABASE_URL must include a database");
  });

  it("returns a frozen object", () => {
    const config = parseDatabaseConfig({});

    expect(Object.isFrozen(config)).toBe(true);
  });
});
