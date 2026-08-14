import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { io, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BetterAuthRedisStorage } from "../src/auth/better-auth-redis.storage";
import { DatabaseService } from "../src/database/database.service";
import { session } from "../src/database/schema";
import { createApplication } from "../src/main";
import { RealtimeGateway } from "../src/realtime/realtime.gateway";

import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";

const enabled = process.env.REALTIME_INTEGRATION === "true";
const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
const mailpitUrl = process.env.MAILPIT_URL ?? "http://localhost:8025";
const password = "Realtime1!Disposable";

async function verificationLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const messages = (await fetch(`${mailpitUrl}/api/v1/messages?limit=50`).then((value) =>
      value.json(),
    )) as { messages?: readonly { ID: string; To?: readonly { Address: string }[] }[] };
    const message = messages.messages?.find((candidate) =>
      candidate.To?.some((recipient) => recipient.Address === email),
    );
    if (message !== undefined) {
      const body = (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`).then((value) =>
        value.json(),
      )) as { Text?: string; HTML?: string };
      const match = `${body.Text ?? ""}\n${body.HTML ?? ""}`.match(/https?:\/\/[^\s"<>]+/u);
      if (match?.[0] !== undefined) return match[0].replaceAll("&amp;", "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Verification email was not delivered");
}

async function identity(app: NestExpressApplication) {
  const email = `realtime-${randomUUID()}@example.test`;
  const server = app.getHttpServer();
  await request(server)
    .post("/api/auth/sign-up/email")
    .set("Origin", origin)
    .send({ name: "Realtime integration", email, password, callbackURL: "/verified" })
    .expect(200);
  const link = new URL(await verificationLink(email));
  await request(server).get(`${link.pathname}${link.search}`).set("Origin", origin).expect(302);
  const login = await request(server)
    .post("/api/auth/sign-in/email")
    .set("Origin", origin)
    .send({ email, password, rememberMe: false })
    .expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as readonly string[])[0];
  if (cookie === undefined) throw new Error("Login did not issue a session cookie");
  const principal = await request(server)
    .get("/api/v1/auth/session")
    .set("Cookie", cookie)
    .expect(200);
  const sessionId = principal.body.sessionId as string;
  const [persisted] = await app
    .get(DatabaseService)
    .db.select({ token: session.token })
    .from(session)
    .where(eq(session.id, sessionId))
    .limit(1);
  if (persisted === undefined) throw new Error("Login session was not persisted");
  return { cookie, sessionId, token: persisted.token };
}

function listenerUrl(app: NestExpressApplication): string {
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function connect(url: string, cookie: string, autoConnect = true): Socket {
  return io(url, {
    path: "/socket.io",
    transports: ["websocket"],
    extraHeaders: { Origin: origin, Cookie: cookie },
    reconnection: false,
    forceNew: true,
    autoConnect,
  });
}

function once(socket: Socket, event: string, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function join(socket: Socket, selector: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => socket.emit("realtime:room:join", { selector }, resolve));
}

describe.skipIf(!enabled)("authenticated Socket.io multi-instance integration", () => {
  let appA: NestExpressApplication;
  let appB: NestExpressApplication;
  const clients: Socket[] = [];

  beforeAll(async () => {
    appA = await createApplication();
    appB = await createApplication();
    await Promise.all([appA.listen(0, "127.0.0.1"), appB.listen(0, "127.0.0.1")]);
  }, 60_000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await Promise.allSettled([appA?.close(), appB?.close()]);
  });

  it("shares authorized probes both ways, conceals rooms, enforces distributed cap/revocation, and survives one instance", async () => {
    const actor = await identity(appA);
    const workspaceSuffix = randomUUID().slice(0, 8);
    const workspace = await request(appA.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ name: `Realtime ${workspaceSuffix}`, slug: `realtime-${workspaceSuffix}` })
      .expect(201);
    const workspaceId = workspace.body.workspace.id as string;
    const note = await request(appA.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/notes`)
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ title: "Realtime note", projectId: null, folderId: null, parentId: null })
      .expect(201);
    const selector = { kind: "note" as const, workspaceId, noteId: note.body.note.id as string };
    const a = connect(listenerUrl(appA), actor.cookie);
    const b = connect(listenerUrl(appB), actor.cookie);
    clients.push(a, b);
    await Promise.all([once(a, "realtime:ready"), once(b, "realtime:ready")]);
    await expect(join(a, selector)).resolves.toEqual({ ok: true });
    await expect(join(b, selector)).resolves.toEqual({ ok: true });

    const fromA = once(b, "realtime:infrastructure:probe");
    appA.get(RealtimeGateway).emitInfrastructureProbe(selector, { nonce: "a-to-b" });
    await expect(fromA).resolves.toEqual({ nonce: "a-to-b" });
    const fromB = once(a, "realtime:infrastructure:probe");
    appB.get(RealtimeGateway).emitInfrastructureProbe(selector, { nonce: "b-to-a" });
    await expect(fromB).resolves.toEqual({ nonce: "b-to-a" });

    const guessed = { ...selector, noteId: randomUUID() };
    await expect(join(a, guessed)).resolves.toEqual({ ok: false, error: "denied" });
    let leaked = false;
    a.once("realtime:infrastructure:probe", () => {
      leaked = true;
    });
    appB.get(RealtimeGateway).emitInfrastructureProbe(guessed, { nonce: "private" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(leaked).toBe(false);

    const outsider = await identity(appB);
    const outsiderClient = connect(listenerUrl(appB), outsider.cookie);
    clients.push(outsiderClient);
    await once(outsiderClient, "realtime:ready");
    await expect(join(outsiderClient, selector)).resolves.toEqual({ ok: false, error: "denied" });

    const additional = Array.from({ length: 6 }, (_, index) =>
      connect(index % 2 === 0 ? listenerUrl(appA) : listenerUrl(appB), actor.cookie),
    );
    clients.push(...additional);
    await Promise.all(additional.map((client) => once(client, "realtime:ready")));
    const overCap = connect(listenerUrl(appB), actor.cookie, false);
    clients.push(overCap);
    const overCapDisconnect = once(overCap, "disconnect");
    overCap.connect();
    await expect(overCapDisconnect).resolves.toBe("io server disconnect");

    await appA.get(DatabaseService).db.delete(session).where(eq(session.id, actor.sessionId));
    await appA.get(BetterAuthRedisStorage).delete(actor.token);
    await expect(
      Promise.race([
        once(a, "disconnect", 35_000).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 35_000)),
      ]),
    ).resolves.toBe(true);

    await appA.close();
    const survivor = await identity(appB);
    const survivingClient = connect(listenerUrl(appB), survivor.cookie);
    clients.push(survivingClient);
    await expect(once(survivingClient, "realtime:ready")).resolves.toEqual({ ok: true });
  }, 120_000);
});
