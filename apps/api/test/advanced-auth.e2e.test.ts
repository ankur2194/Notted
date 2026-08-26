import { createHmac, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BetterAuthRedisStorage } from "../src/auth/better-auth-redis.storage";
import { DatabaseService } from "../src/database/database.service";
import { session, users } from "../src/database/schema";
import { createApplication } from "../src/main";

import type { NestExpressApplication } from "@nestjs/platform-express";

// Part 74's per-identifier authentication budget defaults to 5 requests per
// minute (`RATE_LIMIT_AUTH_PER_MINUTE`, apps/api/src/config/app.config.ts).
// This suite spends more than that on ONE identity before it reaches its first
// assertion — sign-up, sign-in, then the two-factor enable/confirm exchange —
// so without this the run measures the limiter instead of the feature. Set at
// module scope because `parseAppConfig` reads it once, during the
// `createApplication()` in `beforeAll`. `auth.e2e.test.ts` carries the same
// override for the same reason; the `api-e2e` container sets it too, which is
// why this only surfaced once `AUTH_E2E` reached the development stack.
process.env.RATE_LIMIT_AUTH_PER_MINUTE = "10000";
// The `/two-factor/*` paths sit on the SENSITIVE tier (default 10/minute,
// `better-auth.setup.ts`), and Better Auth keeps that counter in
// `secondary-storage` — Redis — keyed by IP and path. The counter is therefore
// shared with every other suite in the run and with the long-lived API
// container on the same stack, so this suite's own 2FA exchange starts partway
// through a bucket somebody else opened. The LIMIT is read from this process's
// config, which is what makes raising it here sufficient. Same reason the
// `api-e2e` profile raises it in `compose.yaml`.
process.env.RATE_LIMIT_SENSITIVE_PER_MINUTE = "10000";

const runLive = process.env.AUTH_E2E === "true";
const appOrigin = process.env.APP_URL ?? "http://localhost:3000";
const rememberedDays = Number(process.env.SESSION_REMEMBER_ME_DAYS ?? "30");

/**
 * `session.createdAt` and `session.expiresAt` are stamped independently — the
 * expiry from `Date.now() + ttl`, the creation timestamp separately — so their
 * difference lands 1 ms short whenever the clock ticks between the two. Exact
 * equality made this suite fail roughly one run in seven with
 * `expected 2591999999 to be 2592000000`, which is the intermittent Part 75
 * recorded and could not name. A 1 s window keeps every property the assertion
 * exists for: the values under test are 1 day against 30 days apart.
 */
function expectSessionTtl(actualMs: number, expectedMs: number): void {
  expect(actualMs).toBeLessThanOrEqual(expectedMs);
  expect(actualMs).toBeGreaterThan(expectedMs - 1_000);
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase().replaceAll("=", "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid authenticator secret encoding");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000;
  return value.toString().padStart(6, "0");
}

describe.skipIf(!runLive)("advanced authentication", () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let authStorage: BetterAuthRedisStorage;

  beforeAll(async () => {
    app = await createApplication();
    await app.init();
    database = app.get(DatabaseService);
    authStorage = app.get(BetterAuthRedisStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  it("enrolls TOTP, consumes recovery codes once, locks repeated failures, and redacts codes", async () => {
    const server = app.getHttpServer();
    const agent = request.agent(server);
    const email = `advanced-${randomUUID()}@example.test`;
    const password = [`Fixture`, randomUUID(), "1!"].join("");

    await agent
      .post("/api/auth/sign-up/email")
      .set("Origin", appOrigin)
      .send({ name: "Advanced Auth", email, password })
      .expect(200);
    await database.db
      .update(users)
      .set({ emailVerified: true, emailVerifiedAt: new Date() })
      .where(eq(users.email, email));
    await agent
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: false })
      .expect(200);

    const csrfDenied = await agent.post("/api/auth/two-factor/enable").send({ password });
    expect(csrfDenied.status).toBe(403);
    expect(JSON.stringify(csrfDenied.body)).not.toContain(password);

    const enrollment = await agent
      .post("/api/auth/two-factor/enable")
      .set("Origin", appOrigin)
      .send({ password })
      .expect(200);
    expect(enrollment.body.totpURI).toMatch(/^otpauth:\/\//u);
    expect(enrollment.body.backupCodes).toHaveLength(10);
    const enrollmentUri = new URL(enrollment.body.totpURI as string);
    const secret = enrollmentUri.searchParams.get("secret");
    expect(secret).not.toBeNull();

    const confirmation = await agent
      .post("/api/auth/two-factor/verify-totp")
      .set("Origin", appOrigin)
      .send({ code: currentTotp(secret!) })
      .expect(200);
    const rotatedCookie = (confirmation.headers["set-cookie"] as unknown as readonly string[])
      .filter((value) => value.includes("session_token"))
      .at(-1);
    expect(rotatedCookie).not.toMatch(/Max-Age=/iu);

    const rotatedPrincipal = await agent.get("/api/v1/auth/session").expect(200);
    const rotatedRows = await database.db
      .select({ createdAt: session.createdAt, expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.id, rotatedPrincipal.body.sessionId as string));
    expectSessionTtl(
      rotatedRows[0]!.expiresAt.getTime() - rotatedRows[0]!.createdAt.getTime(),
      86_400_000,
    );
    const overwriteAttempt = await agent
      .post("/api/auth/two-factor/enable")
      .set("Origin", appOrigin)
      .send({ password });
    expect(overwriteAttempt.status).toBeGreaterThanOrEqual(400);
    expect(overwriteAttempt.body).not.toHaveProperty("backupCodes");
    expect(JSON.stringify(overwriteAttempt.body)).not.toContain(secret!);

    await agent.post("/api/auth/sign-out").set("Origin", appOrigin).expect(200);
    const challenged = await agent
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: false })
      .expect(200);
    expect(challenged.body).toMatchObject({ twoFactorRedirect: true });

    const recoveryCode = (enrollment.body.backupCodes as readonly string[])[0]!;
    await agent
      .post("/api/auth/two-factor/verify-backup-code")
      .set("Origin", appOrigin)
      .send({ code: recoveryCode })
      .expect(200);
    const replay = await agent
      .post("/api/auth/two-factor/verify-backup-code")
      .set("Origin", appOrigin)
      .send({ code: recoveryCode });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(replay.body)).not.toContain(recoveryCode);
    expect(JSON.stringify(replay.body)).not.toContain(secret!);

    await agent.post("/api/auth/sign-out").set("Origin", appOrigin).expect(200);
    const invalidTotp = currentTotp(secret!) === "000000" ? "000001" : "000000";
    for (let challenge = 0; challenge < 2; challenge += 1) {
      await agent
        .post("/api/auth/sign-in/email")
        .set("Origin", appOrigin)
        .send({ email, password })
        .expect(200);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const denied = await agent
          .post("/api/auth/two-factor/verify-totp")
          .set("Origin", appOrigin)
          .send({ code: invalidTotp });
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(denied.body)).not.toContain(invalidTotp);
      }
    }
    const locked = await agent
      .post("/api/auth/two-factor/verify-totp")
      .set("Origin", appOrigin)
      .send({ code: currentTotp(secret!) });
    expect(locked.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(locked.body)).not.toContain(secret!);
  });

  it("applies remembered expiry, projects safe sessions, enforces origin, and revokes remotely", async () => {
    const server = app.getHttpServer();
    const registrationAgent = request.agent(server);
    const email = `sessions-${randomUUID()}@example.test`;
    const password = [`Fixture`, randomUUID(), "2!"].join("");
    await registrationAgent
      .post("/api/auth/sign-up/email")
      .set("Origin", appOrigin)
      .send({ name: "Session Auth", email, password })
      .expect(200);
    await database.db
      .update(users)
      .set({ emailVerified: true, emailVerifiedAt: new Date() })
      .where(eq(users.email, email));

    const shortAgent = request.agent(server);
    const shortLogin = await shortAgent
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: false })
      .expect(200);
    const shortPrincipal = await shortAgent.get("/api/v1/auth/session").expect(200);
    const shortCookie = (shortLogin.headers["set-cookie"] as unknown as readonly string[]).find(
      (value) => value.includes("session_token"),
    );
    expect(shortCookie).not.toMatch(/Max-Age=/iu);

    const rememberedAgent = request.agent(server);
    const rememberedLogin = await rememberedAgent
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: true })
      .expect(200);
    const rememberedPrincipal = await rememberedAgent.get("/api/v1/auth/session").expect(200);
    const rememberedCookie = (
      rememberedLogin.headers["set-cookie"] as unknown as readonly string[]
    ).find((value) => value.includes("session_token"));
    expect(rememberedCookie).toMatch(/Max-Age=/iu);

    const persisted = await database.db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        token: session.token,
      })
      .from(session)
      .where(
        and(
          eq(session.userId, shortPrincipal.body.userId as string),
          eq(session.id, shortPrincipal.body.sessionId as string),
        ),
      );
    expectSessionTtl(
      persisted[0]!.expiresAt.getTime() - persisted[0]!.createdAt.getTime(),
      86_400_000,
    );
    const rememberedPersisted = await database.db
      .select({ createdAt: session.createdAt, expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.id, rememberedPrincipal.body.sessionId as string));
    expectSessionTtl(
      rememberedPersisted[0]!.expiresAt.getTime() - rememberedPersisted[0]!.createdAt.getTime(),
      rememberedDays * 86_400_000,
    );

    const security = await shortAgent.get("/api/v1/auth/security").expect(200);
    expect(security.body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shortPrincipal.body.sessionId, current: true }),
        expect.objectContaining({ id: rememberedPrincipal.body.sessionId, current: false }),
      ]),
    );
    expect(JSON.stringify(security.body)).not.toContain(persisted[0]!.token);
    expect(JSON.stringify(security.body)).not.toMatch(/credentialID|publicKey|ipAddress/iu);
    await shortAgent.get("/api/auth/list-sessions").set("Origin", appOrigin).expect(404);
    await shortAgent
      .get("/api/auth/passkey/list-user-passkeys")
      .set("Origin", appOrigin)
      .expect(404);

    await shortAgent
      .delete(`/api/v1/auth/sessions/${rememberedPrincipal.body.sessionId as string}`)
      .expect(403);
    await shortAgent
      .delete(`/api/v1/auth/sessions/${rememberedPrincipal.body.sessionId as string}`)
      .set("Origin", "https://attacker.invalid")
      .expect(403);

    const staleCreatedAt = new Date(Date.now() - 3_600_000);
    await database.db
      .update(session)
      .set({ createdAt: staleCreatedAt })
      .where(eq(session.id, shortPrincipal.body.sessionId as string));
    const cachedSession = await authStorage.get(persisted[0]!.token);
    if (cachedSession === null) throw new Error("Expected authoritative cached session fixture");
    const cachedValue = JSON.parse(cachedSession) as {
      session: { createdAt: string };
      user: Record<string, unknown>;
    };
    cachedValue.session.createdAt = staleCreatedAt.toISOString();
    await authStorage.set(persisted[0]!.token, JSON.stringify(cachedValue), 86_400);

    const staleMutation = await shortAgent
      .delete(`/api/v1/auth/sessions/${rememberedPrincipal.body.sessionId as string}`)
      .set("Origin", appOrigin);
    expect(staleMutation.status).toBe(403);
    expect(staleMutation.body).toMatchObject({
      error: { code: "RECENT_AUTHENTICATION_REQUIRED" },
    });
    expect(JSON.stringify(staleMutation.body)).not.toContain(password);
    await shortAgent
      .post("/api/auth/notted/reauthenticate")
      .set("Origin", appOrigin)
      .send({ password })
      .expect(200);
    await shortAgent
      .delete(`/api/v1/auth/sessions/${rememberedPrincipal.body.sessionId as string}`)
      .set("Origin", appOrigin)
      .expect(200);
    await rememberedAgent.get("/api/v1/auth/session").expect(401);

    const thirdAgent = request.agent(server);
    await thirdAgent
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: true })
      .expect(200);
    await shortAgent
      .post("/api/v1/auth/sessions/revoke-others")
      .set("Origin", appOrigin)
      .expect(200);
    await thirdAgent.get("/api/v1/auth/session").expect(401);
    await shortAgent.get("/api/v1/auth/session").expect(200);

    const remaining = await database.db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, shortPrincipal.body.userId as string));
    expect(remaining.some((row) => row.id === rememberedPrincipal.body.sessionId)).toBe(false);
  });
});
