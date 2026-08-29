import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTH_LOCKOUT_MESSAGE } from "../src/auth/auth-lockout.service";
import { DatabaseService } from "../src/database/database.service";
import { authEmailIntents, emailDeliveries, jobOutbox } from "../src/database/schema";
import { createApplication } from "../src/main";

import type { NestExpressApplication } from "@nestjs/platform-express";

// Part 74. Set before `createApplication()` is ever called (module scope,
// read once by `parseAppConfig`/`parseAuthConfig` at bootstrap). Otherwise
// the per-identifier request budget (default 5/minute) would trip this suite
// before its own tests get anywhere near the account lockout, and the
// default lockout threshold (10 failures) would take too many requests to
// observe; 3 makes it observable in a handful of requests.
process.env.RATE_LIMIT_AUTH_PER_MINUTE = "10000";
process.env.AUTH_LOCKOUT_ATTEMPTS = "3";

const runLive = process.env.AUTH_E2E === "true";
const appOrigin = process.env.APP_URL ?? "http://localhost:3000";
const mailpitUrl = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

interface MailpitMessageSummary {
  readonly ID: string;
  readonly Subject: string;
}

interface MailpitSearchResponse {
  readonly messages: readonly MailpitMessageSummary[];
}

interface MailpitMessage {
  readonly Text: string;
  readonly HTML: string;
}

// `subject` is matched against the Mailpit summary's `Subject`: the auth
// templates put their purpose in the subject line only, never in the body.
async function readMailpitLink(email: string, subject: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    if (search.ok) {
      const payload = (await search.json()) as MailpitSearchResponse;
      const latest = payload.messages.find((message) => message.Subject.includes(subject));
      if (latest !== undefined) {
        const response = await fetch(`${mailpitUrl}/api/v1/message/${latest.ID}`);
        const message = (await response.json()) as MailpitMessage;
        const decoded = `${message.Text}\n${message.HTML}`.replaceAll("&amp;", "&");
        const match = decoded.match(/https?:\/\/[^\s"<]+/u);
        if (match?.[0] !== undefined) {
          return match[0];
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Mailpit did not receive the expected authentication email");
}

describe.skipIf(!runLive)("Better Auth backend with Mailpit", () => {
  let app: NestExpressApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    app = await createApplication();
    await app.init();
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  // `readMailpitLink` polls for up to 10 s per message and this case reads
  // three of them; vitest's default `testTimeout` is 5 s (`vitest.config.ts`
  // raises only `hookTimeout`), so the timeout has to be stated per test.
  it("covers registration, verification, login, session lookup, logout, magic link and reset", async () => {
    const email = `auth-${randomUUID()}@example.test`;
    const password = "Strong1!Password";
    const server = app.getHttpServer();

    const registration = await request(server)
      .post("/api/auth/sign-up/email")
      .set("Origin", appOrigin)
      .send({ name: "Auth E2E", email, password, callbackURL: "/verified" });
    expect(registration.status).toBe(200);
    expect(registration.headers["set-cookie"]).toBeUndefined();

    const resendKnown = await request(server)
      .post("/api/auth/send-verification-email")
      .set("Origin", appOrigin)
      .send({ email, callbackURL: "/verified" })
      .expect(200);
    const resendUnknown = await request(server)
      .post("/api/auth/send-verification-email")
      .set("Origin", appOrigin)
      .send({ email: `unknown-${randomUUID()}@example.test`, callbackURL: "/verified" })
      .expect(200);
    expect(resendKnown.body).toEqual(resendUnknown.body);

    const verificationUrl = await readMailpitLink(email, "Verify your Notted email");
    const verification = new URL(verificationUrl);
    await request(server)
      .get(`${verification.pathname}${verification.search}`)
      .set("Origin", appOrigin)
      .expect(302);

    const badOrigin = await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", "https://attacker.invalid")
      .send({ email, password });
    expect(badOrigin.status).toBeGreaterThanOrEqual(400);

    const login = await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: false })
      .expect(200);
    const cookie = (login.headers["set-cookie"] as unknown as readonly string[])[0];
    if (cookie === undefined) throw new Error("Login did not set a session cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const session = await request(server)
      .get("/api/v1/auth/session")
      .set("Cookie", cookie)
      .expect(200);
    expect(session.body).toMatchObject({ method: "opaque-session", assurance: "single-factor" });
    expect(session.body).not.toHaveProperty("token");
    expect(session.body).not.toHaveProperty("workspaceId");
    expect(session.body).not.toHaveProperty("role");

    await request(server)
      .post("/api/auth/sign-out")
      .set("Origin", appOrigin)
      .set("Cookie", cookie)
      .expect(200);
    await request(server).get("/api/v1/auth/session").set("Cookie", cookie).expect(401);

    const unknownEmail = `unknown-${randomUUID()}@example.test`;
    const knownReset = await request(server)
      .post("/api/auth/notted/request-password-reset")
      .set("Origin", appOrigin)
      .send({ email })
      .expect(200);
    const unknownReset = await request(server)
      .post("/api/auth/notted/request-password-reset")
      .set("Origin", appOrigin)
      .send({ email: unknownEmail })
      .expect(200);
    expect(knownReset.body).toEqual(unknownReset.body);

    const resetUrl = new URL(await readMailpitLink(email, "Reset your Notted password"));
    const resetToken = resetUrl.searchParams.get("token");
    expect(resetToken).not.toBeNull();
    await request(server)
      .post("/api/auth/notted/reset-password")
      .set("Origin", appOrigin)
      .send({ token: resetToken, newPassword: "Changed2!Password" })
      .expect(200);
    await request(server)
      .post("/api/auth/notted/reset-password")
      .set("Origin", appOrigin)
      .send({ token: resetToken, newPassword: "Changed2!Password" })
      .expect(400);
    await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password })
      .expect(401);
    await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password: "Changed2!Password" })
      .expect(200);

    await request(server)
      .post("/api/auth/sign-in/magic-link")
      .set("Origin", appOrigin)
      .send({ email, callbackURL: "/" })
      .expect(200);
    const magicUrl = new URL(await readMailpitLink(email, "Your Notted magic link"));
    expect(magicUrl.pathname).toContain("/magic-link/verify");
    const magicVerification = await request(server)
      .get(`${magicUrl.pathname}${magicUrl.search}`)
      .set("Origin", appOrigin)
      .expect(302);
    const magicCookie = (
      magicVerification.headers["set-cookie"] as unknown as readonly string[]
    )[0];
    if (magicCookie === undefined) throw new Error("Magic link did not set a session cookie");
    await request(server).get("/api/v1/auth/session").set("Cookie", magicCookie).expect(200);

    const persisted = await database.db
      .select({ intent: authEmailIntents, outboxPayload: jobOutbox.payload })
      .from(authEmailIntents)
      .innerJoin(emailDeliveries, eq(authEmailIntents.deliveryId, emailDeliveries.id))
      .innerJoin(
        jobOutbox,
        and(eq(jobOutbox.queueName, "auth-email"), eq(jobOutbox.jobType, "deliver-auth-email")),
      )
      .where(eq(emailDeliveries.recipient, email));
    expect(persisted.length).toBeGreaterThan(0);
    for (const row of persisted) {
      expect(row.intent.encryptedContext).not.toContain("token=");
      expect(Object.keys(row.outboxPayload).sort()).toEqual(["action", "intentId"]);
      expect(JSON.stringify(row.outboxPayload)).not.toMatch(/token|password|cookie|url/iu);
    }
  }, 30_000);

  it("locks an identifier after repeated failed sign-ins", async () => {
    const server = app.getHttpServer();
    // A non-existent account: the lockout behavior must be identical to a
    // real one, or its presence would itself leak which emails are real.
    const email = `lockout-${randomUUID()}@example.test`;
    const attempt = () =>
      request(server)
        .post("/api/auth/sign-in/email")
        .set("Origin", appOrigin)
        .send({ email, password: "Wrong1!Password" });

    const first = await attempt();
    const second = await attempt();
    const third = await attempt();
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(401);

    const fourth = await attempt();
    expect(fourth.status).toBe(423);
    expect(fourth.headers["retry-after"]).toBeDefined();
    // The locked response carries the fixed enumeration-safe constant, not a
    // message assembled per account.
    expect(fourth.body).toMatchObject({ code: "ACCOUNT_LOCKED", message: AUTH_LOCKOUT_MESSAGE });
    // Neither the wrong-password responses nor the locked response names the
    // account as unknown or nonexistent — both read the same to an attacker
    // probing emails.
    for (const response of [first, second, third, fourth]) {
      expect(JSON.stringify(response.body)).not.toMatch(/exist|not found|unknown user/iu);
    }

    /*
     * PASSWORD RESET IS THE WAY OUT, so the lock must not seal it.
     *
     * Only `/sign-in/email` failures record a failure, and each lock runs for
     * `lockoutSeconds` from the moment it is set — so an attacker who can spend
     * the attempt budget holds the lock open indefinitely. If the lock also
     * gated this endpoint the victim's only escape hatch would be closed by the
     * attack itself. It used to, because `assertNotLocked` ran on every path in
     * `AUTH_IDENTIFIER_PATHS`.
     *
     * `202` either way, which is the same enumeration-safe answer this endpoint
     * gives for an address that does not exist.
     */
    const resetWhileLocked = await request(server)
      .post("/api/auth/notted/request-password-reset")
      .set("Origin", appOrigin)
      .send({ email });
    expect(resetWhileLocked.status).not.toBe(423);
    expect(JSON.stringify(resetWhileLocked.body)).not.toContain("ACCOUNT_LOCKED");

    // And sign-in is still locked: the exemption is scoped to the reset path.
    expect((await attempt()).status).toBe(423);
  });

  it("refuses an oversized or undeclared auth body with the documented 413", async () => {
    const server = app.getHttpServer();
    /*
     * `docs/API.md` promises `413 PAYLOAD_TOO_LARGE` past
     * `REQUEST_BODY_LIMIT_BYTES`. It did not hold on `/api/auth/**`: Better Auth
     * is mounted BEFORE `json({ limit })` and reads the raw stream itself, so
     * the limiter never saw these requests.
     */
    const oversized = await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "a@example.test", password: "x".repeat(2 * 1_024 * 1_024) }));
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });

    /*
     * And a body with NO declared length. `better-call` computes
     * `length = Number(content_length)`, which is `NaN` without the header, and
     * its `size > length` guard is then always false — so a chunked body would
     * stream with no cap whatsoever. Absent must be refused, not trusted.
     *
     * Raw `node:http`, not supertest: superagent always sets `content-length`,
     * and setting `transfer-encoding` on top makes Node's parser refuse the
     * request outright (400) as smuggling-shaped. Only a hand-built chunked
     * request actually reaches the middleware.
     */
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };
    const undeclaredStatus = await new Promise<number>((resolve, reject) => {
      const chunked = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/api/auth/sign-in/email",
          headers: {
            origin: appOrigin,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      chunked.on("error", reject);
      chunked.end(JSON.stringify({ email: "a@example.test", password: "Wrong1!Password" }));
    });
    expect(undeclaredStatus).toBe(413);

    // An ordinary request is unaffected.
    const ordinary = await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email: `absent-${randomUUID()}@example.test`, password: "Wrong1!Password" });
    expect(ordinary.status).not.toBe(413);
  });

  // Reads one verification email — see the timeout note above.
  it("issues a distinct session cookie for each sign-in", async () => {
    const server = app.getHttpServer();
    const email = `session-${randomUUID()}@example.test`;
    const password = "Strong1!Password";

    await request(server)
      .post("/api/auth/sign-up/email")
      .set("Origin", appOrigin)
      .send({ name: "Session E2E", email, password, callbackURL: "/verified" })
      .expect(200);

    const verificationUrl = await readMailpitLink(email, "Verify your Notted email");
    const verification = new URL(verificationUrl);
    await request(server)
      .get(`${verification.pathname}${verification.search}`)
      .set("Origin", appOrigin)
      .expect(302);

    const firstLogin = await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: false })
      .expect(200);
    const secondLogin = await request(server)
      .post("/api/auth/sign-in/email")
      .set("Origin", appOrigin)
      .send({ email, password, rememberMe: false })
      .expect(200);

    const firstCookie = (firstLogin.headers["set-cookie"] as unknown as readonly string[])[0];
    const secondCookie = (secondLogin.headers["set-cookie"] as unknown as readonly string[])[0];
    if (firstCookie === undefined || secondCookie === undefined) {
      throw new Error("Sign-in did not set a session cookie");
    }
    // No session fixation: each sign-in mints a fresh, distinct session token.
    expect(firstCookie).not.toBe(secondCookie);
  }, 30_000);
});
