import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseService } from "../src/database/database.service";
import { authEmailIntents, emailDeliveries, jobOutbox } from "../src/database/schema";
import { createApplication } from "../src/main";

import type { NestExpressApplication } from "@nestjs/platform-express";

const runLive = process.env.AUTH_E2E === "true";
const appOrigin = process.env.APP_URL ?? "http://localhost:3000";
const mailpitUrl = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

interface MailpitMessageSummary {
  readonly ID: string;
}

interface MailpitSearchResponse {
  readonly messages: readonly MailpitMessageSummary[];
}

interface MailpitMessage {
  readonly Text: string;
  readonly HTML: string;
}

async function readMailpitLink(email: string, marker: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    if (search.ok) {
      const payload = (await search.json()) as MailpitSearchResponse;
      const latest = payload.messages[0];
      if (latest !== undefined) {
        const response = await fetch(`${mailpitUrl}/api/v1/message/${latest.ID}`);
        const message = (await response.json()) as MailpitMessage;
        const decoded = `${message.Text}\n${message.HTML}`.replaceAll("&amp;", "&");
        const match = decoded.match(/https?:\/\/[^\s"<]+/u);
        if (match?.[0] !== undefined && decoded.includes(marker)) {
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
  });
});
