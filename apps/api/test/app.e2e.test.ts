import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApplication } from "../src/main";

import type { INestApplication } from "@nestjs/common";

const ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "API_HOST",
  "API_PORT",
  "APP_URL",
  // Overridden alongside `APP_URL` below: the auth config requires the trusted
  // origins to include it, so inheriting the ambient value — which the dev
  // container sets to `http://localhost:3000` — aborts boot with "Invalid auth
  // configuration". Unset on a developer host, which is why this only failed
  // under `docker compose exec api pnpm test`.
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "DATABASE_URL",
  "LOG_LEVEL",
  "TRUST_PROXY_HOPS",
  "REQUEST_BODY_LIMIT_BYTES",
  "RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE",
  "RATE_LIMIT_AUTHENTICATED_PER_MINUTE",
  "FEATURE_REDIS_ENABLED",
  "FEATURE_REALTIME_ENABLED",
  "FEATURE_STORAGE_ENABLED",
  "FEATURE_SEARCH_ENABLED",
  "FEATURE_EMAIL_ENABLED",
] as const;

type EnvironmentSnapshot = Readonly<Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>>;

function snapshotEnvironment(): EnvironmentSnapshot {
  return Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as EnvironmentSnapshot;
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe.sequential("API scaffold", () => {
  let app: INestApplication;
  let environment: EnvironmentSnapshot;

  beforeAll(async () => {
    environment = snapshotEnvironment();
    Object.assign(process.env, {
      NODE_ENV: "test",
      APP_URL: "https://notted.example",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://notted.example",
      // Point the database at a closed local port so the readiness indicator
      // fails fast and deterministically instead of depending on a live
      // PostgreSQL in the CI runner.
      DATABASE_URL: "postgres://notted:notted_dev_password@127.0.0.1:54321/notted_dev",
      LOG_LEVEL: "silent",
      REQUEST_BODY_LIMIT_BYTES: "1024",
      RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "100",
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "1000",
      FEATURE_REDIS_ENABLED: "false",
      FEATURE_REALTIME_ENABLED: "false",
      FEATURE_STORAGE_ENABLED: "false",
      FEATURE_SEARCH_ENABLED: "false",
      FEATURE_EMAIL_ENABLED: "false",
    });
    app = await createApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    restoreEnvironment(environment);
  });

  it("exposes dependency-free liveness outside the versioned prefix", async () => {
    const response = await request(app.getHttpServer()).get("/health/live").expect(200);

    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("reports deterministic required and disabled dependency readiness", async () => {
    const response = await request(app.getHttpServer()).get("/health/ready").expect(503);

    expect(response.body.status).toBe("not_ready");
    expect(
      response.body.checks.map(({ durationMs, ...check }: { durationMs: number; name: string }) => {
        void durationMs;
        return check;
      }),
    ).toEqual([
      { name: "api", status: "up" },
      { name: "database", status: "down", message: "database query failed" },
      { name: "redis", status: "disabled" },
      { name: "queue", status: "disabled", message: "Queue execution is disabled." },
      { name: "minio", status: "disabled" },
      { name: "meilisearch", status: "disabled" },
      { name: "smtp", status: "disabled" },
      { name: "realtime", status: "disabled" },
    ]);
    expect(
      response.body.checks.every(
        ({ durationMs }: { durationMs: unknown }) =>
          typeof durationMs === "number" && durationMs >= 0,
      ),
    ).toBe(true);
  });

  it("serves the versioned API root with security and rate-limit headers", async () => {
    const response = await request(app.getHttpServer()).get("/api/v1").expect(200);

    expect(response.body).toEqual({
      success: true,
      data: { name: "Notted API", version: "v1", status: "ok" },
      requestId: response.headers["x-request-id"],
    });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["ratelimit-limit"]).toBe("100");
    expect(Number(response.headers["ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
    expect(Number(response.headers["ratelimit-remaining"])).toBeLessThan(100);
  });

  it("allows only the configured browser origin through CORS", async () => {
    const allowed = await request(app.getHttpServer())
      .get("/api/v1")
      .set("Origin", "https://notted.example")
      .expect(200);
    const denied = await request(app.getHttpServer())
      .get("/api/v1")
      .set("Origin", "https://attacker.example")
      .expect(200);

    expect(allowed.headers["access-control-allow-origin"]).toBe("https://notted.example");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preserves a safe UUID request ID and replaces malformed input", async () => {
    const safeRequestId = "9bb58c7e-8f49-4a7d-b60c-0e32a30a2980";
    const accepted = await request(app.getHttpServer())
      .get("/health/live")
      .set("X-Request-Id", safeRequestId)
      .expect(200);
    const replaced = await request(app.getHttpServer())
      .get("/health/live")
      .set("X-Request-Id", "attacker-controlled-request-id")
      .expect(200);

    expect(accepted.headers["x-request-id"]).toBe(safeRequestId);
    expect(replaced.headers["x-request-id"]).not.toBe("attacker-controlled-request-id");
    expect(replaced.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("maps malformed JSON to a safe consistent error envelope", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1")
      .set("Content-Type", "application/json")
      .send('{"broken":')
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "BAD_REQUEST",
        message: "The request is invalid.",
      },
      requestId: response.headers["x-request-id"],
    });
    expect(JSON.stringify(response.body)).not.toContain('{"broken":');
  });

  it("rejects request bodies above the configured bound without echoing content", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ content: "sensitive".repeat(200) }))
      .expect(413);

    expect(response.body.error).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body is too large.",
    });
    expect(JSON.stringify(response.body)).not.toContain("sensitive");
  });
});

describe.sequential("unauthenticated rate-limit trust boundary", () => {
  let app: INestApplication;
  let environment: EnvironmentSnapshot;

  beforeAll(async () => {
    environment = snapshotEnvironment();
    Object.assign(process.env, {
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      LOG_LEVEL: "silent",
      RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "1",
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "1000",
      FEATURE_REDIS_ENABLED: "false",
      FEATURE_REALTIME_ENABLED: "false",
      FEATURE_STORAGE_ENABLED: "false",
      FEATURE_SEARCH_ENABLED: "false",
      FEATURE_EMAIL_ENABLED: "false",
    });
    app = await createApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    restoreEnvironment(environment);
  });

  it("does not grant the authenticated tier from an authorization header", async () => {
    await request(app.getHttpServer())
      .get("/api/v1")
      .set("Authorization", "Bearer not-validated")
      .expect(200);
    const response = await request(app.getHttpServer())
      .get("/api/v1")
      .set("Authorization", "Bearer not-validated")
      .expect(429);

    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.body.error.code).toBe("RATE_LIMITED");
  });
});
