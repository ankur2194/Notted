import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { io, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BetterAuthRedisStorage } from "../src/auth/better-auth-redis.storage";
import { DatabaseService } from "../src/database/database.service";
import { noteCollaborationUpdates, notes, noteVersions, session } from "../src/database/schema";
import { createApplication } from "../src/main";
import { RealtimeGateway } from "../src/realtime/realtime.gateway";

import type { PresenceEntry } from "../src/realtime/realtime.contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";

// Part 74's per-identifier authentication budget defaults to 5 requests per
// minute (`RATE_LIMIT_AUTH_PER_MINUTE`, apps/api/src/config/app.config.ts).
// This suite registers and signs in at least two identities per test across
// four tests, so on the default budget it measures the limiter and never
// reaches an assertion — `expected 200 "OK", got 429 "Too Many Requests"` from
// `identity()`. Set at module scope because `parseAppConfig` reads it once,
// during the `createApplication()` in `beforeAll`. `advanced-auth.e2e.test.ts`
// and `auth.e2e.test.ts` carry the same override for the same reason.
process.env.RATE_LIMIT_AUTH_PER_MINUTE = "10000";
// The counter behind the sensitive tier lives in Redis, shared with the
// long-lived API container on the same stack, so this suite starts partway
// through a bucket somebody else opened. The LIMIT is read from this process's
// config, which is what makes raising it here sufficient.
process.env.RATE_LIMIT_SENSITIVE_PER_MINUTE = "10000";

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

type PresenceAck =
  | {
      readonly ok: true;
      readonly presence: PresenceEntry;
      readonly viewers: readonly PresenceEntry[];
      readonly viewerCount: number;
    }
  | { readonly ok: false; readonly error: string; readonly viewerCount?: number };

/**
 * The payload is `unknown` on purpose: the forgery case has to put keys on the
 * wire that the strict schema does not accept, which a typed argument would
 * reject at compile time instead of at the trust boundary being tested.
 */
function presenceAnnounce(socket: Socket, payload: unknown): Promise<PresenceAck> {
  return new Promise((resolve) => socket.emit("realtime:presence:announce", payload, resolve));
}

/** Server -> room presence frames are `unknown` off the wire; narrow them once. */
function presenceJoinedFrame(payload: unknown): { noteId: string; presence: PresenceEntry } {
  return payload as { noteId: string; presence: PresenceEntry };
}

interface SyncAck {
  readonly ok: boolean;
  readonly error?: string;
  readonly epoch: number;
  readonly update: ArrayBufferLike;
}

function collaborationSync(socket: Socket, selector: unknown, doc: Y.Doc): Promise<SyncAck> {
  return new Promise((resolve) =>
    socket.emit(
      "realtime:note:sync",
      { selector, schemaVersion: 1, stateVector: Y.encodeStateVector(doc) },
      resolve,
    ),
  );
}

function collaborationUpdate(
  socket: Socket,
  selector: unknown,
  epoch: number,
  update: Uint8Array,
): Promise<{ ok: boolean; error?: string; revision?: number }> {
  return new Promise((resolve) =>
    socket.emit("realtime:note:update", { selector, epoch, update }, resolve),
  );
}

/** One local edit encoded as the delta the server has not seen yet. */
function localEdit(doc: Y.Doc, text: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const element = new Y.XmlElement("paragraph");
  doc.getXmlFragment("default").insert(0, [element]);
  const inner = new Y.XmlText();
  element.insert(0, [inner]);
  inner.insert(0, text);
  return Y.encodeStateAsUpdate(doc, before);
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Condition was not reached before the deadline");
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

  // Runs BEFORE the probe suite, which deliberately closes appA at its end.
  it("converges two instances, persists each update once, and projects to PostgreSQL", async () => {
    const actor = await identity(appA);
    const suffix = randomUUID().slice(0, 8);
    const workspace = await request(appA.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ name: `Collab ${suffix}`, slug: `collab-${suffix}` })
      .expect(201);
    const workspaceId = workspace.body.workspace.id as string;
    const created = await request(appA.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/notes`)
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ title: "Collab note", projectId: null, folderId: null, parentId: null })
      .expect(201);
    const noteId = created.body.note.id as string;
    const selector = { kind: "note" as const, workspaceId, noteId };

    const a = connect(listenerUrl(appA), actor.cookie);
    const b = connect(listenerUrl(appB), actor.cookie);
    clients.push(a, b);
    await Promise.all([once(a, "realtime:ready"), once(b, "realtime:ready")]);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const ackA = await collaborationSync(a, selector, docA);
    const ackB = await collaborationSync(b, selector, docB);
    expect(ackA).toMatchObject({ ok: true, epoch: ackB.epoch });
    Y.applyUpdate(docA, new Uint8Array(ackA.update));
    Y.applyUpdate(docB, new Uint8Array(ackB.update));

    // An outsider cannot write, and nothing they send reaches the room.
    const outsider = await identity(appB);
    const outsiderClient = connect(listenerUrl(appB), outsider.cookie);
    clients.push(outsiderClient);
    await once(outsiderClient, "realtime:ready");
    let leaked = false;
    a.once("realtime:note:remote", () => {
      leaked = true;
    });
    await expect(
      collaborationUpdate(outsiderClient, selector, ackA.epoch, localEdit(new Y.Doc(), "forged")),
    ).resolves.toEqual({ ok: false, error: "denied" });
    /*
     * A BARRIER, NOT A SLEEP. This used to be `setTimeout(300)` then
     * `expect(leaked).toBe(false)`, which proves nothing under load: a frame
     * that leaks and arrives at 310 ms passes.
     *
     * The barrier is published by the SAME gateway instance the outsider is
     * connected to (`appB`), into a room this socket has joined, over the same
     * Redis channel, after the denied write's ack has already been awaited. Any
     * leaked frame would have to be produced while that write was handled — so
     * it is strictly earlier in the publisher's queue, and Socket.IO preserves
     * per-socket ordering across event names on one connection. Receiving the
     * barrier therefore proves the socket has drained everything the denied
     * write could have produced. That is a happens-before, not a hope.
     */
    const drained = once(a, "realtime:infrastructure:probe");
    appB.get(RealtimeGateway).emitInfrastructureProbe(selector, { nonce: "denied-write-barrier" });
    await expect(drained).resolves.toEqual({ nonce: "denied-write-barrier" });
    expect(leaked).toBe(false);
    a.off("realtime:note:remote");

    // A edits; B must receive the relay on the OTHER instance.
    const onB = once(b, "realtime:note:remote");
    const fromA = localEdit(docA, "written on A");
    await expect(collaborationUpdate(a, selector, ackA.epoch, fromA)).resolves.toMatchObject({
      ok: true,
    });
    Y.applyUpdate(docB, new Uint8Array(((await onB) as { update: ArrayBufferLike }).update));

    const onA = once(a, "realtime:note:remote");
    const fromB = localEdit(docB, "written on B");
    await expect(collaborationUpdate(b, selector, ackB.epoch, fromB)).resolves.toMatchObject({
      ok: true,
    });
    Y.applyUpdate(docA, new Uint8Array(((await onA) as { update: ArrayBufferLike }).update));

    // Convergence is the CRDT's property, not the server's: no server-side doc
    // was ever mutated, yet both clients hold the same fragment.
    expect(docA.getXmlFragment("default").toJSON()).toEqual(
      docB.getXmlFragment("default").toJSON(),
    );

    const db = appB.get(DatabaseService).db;
    const persisted = await db
      .select({ kind: noteCollaborationUpdates.kind })
      .from(noteCollaborationUpdates)
      .where(eq(noteCollaborationUpdates.noteId, noteId));
    // Exactly one row per client update, plus the seed snapshot. A relay that
    // was persisted twice, or a broadcast that was persisted on both instances,
    // would show up here immediately.
    expect(persisted.filter((row) => row.kind === "update")).toHaveLength(2);

    // Leaving is a forced boundary, so the projection must also write a durable
    // checkpoint rather than deferring on the five-minute cadence.
    await new Promise((resolve) => a.emit("realtime:room:leave", { selector }, resolve));

    // The debounced projection folds the log back into authoritative PostgreSQL.
    await eventually(async () => {
      const [row] = await db
        .select({ contentPlain: notes.contentPlain })
        .from(notes)
        .where(eq(notes.id, noteId))
        .limit(1);
      const plain = row?.contentPlain ?? "";
      return plain.includes("written on A") && plain.includes("written on B");
    });
    // Polled, because the boundary checkpoint is asynchronous BY DESIGN and can
    // legitimately land after the projection it records: when the other
    // instance's debounce wins the `notes.version` compare-and-set, this
    // instance's forced boundary settles against the state that instance just
    // wrote. Still unfalsifiable-proof — it fails if no checkpoint is ever
    // written, and the count below fails on a duplicate.
    await eventually(async () => {
      const [note] = await db
        .select({ version: notes.version })
        .from(notes)
        .where(eq(notes.id, noteId))
        .limit(1);
      const rows = await db
        .select({ version: noteVersions.version })
        .from(noteVersions)
        .where(and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, note?.version ?? 0)));
      return rows.length === 1;
    });

    const [projected] = await db
      .select({ version: notes.version })
      .from(notes)
      .where(eq(notes.id, noteId))
      .limit(1);
    const checkpoints = await db
      .select({ version: noteVersions.version })
      .from(noteVersions)
      .where(
        and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, projected?.version ?? 0)),
      );
    // Exactly one: a room with N participants schedules N forced boundaries, so
    // a missing suppression guard would show up here as a duplicate rather than
    // as a unique-violation nobody sees.
    expect(checkpoints).toHaveLength(1);
  }, 120_000);

  /**
   * Part 59 presence. Also runs BEFORE the probe suite, which closes appA.
   *
   * The load-bearing claim is that the roster is DERIVED, not stored: the server
   * reads it live from `fetchSockets()` over the Redis adapter, so it crosses
   * instances with no table, no Redis key and no sweep job that could leave a
   * stale viewer behind. Every removal below therefore has to arrive from the
   * one teardown seam — the gateway's `cleanup()` — which is what makes the
   * crash case indistinguishable from the graceful one.
   */
  it("mints a cross-instance roster and removes presence on leave, on crash, and never on forgery", async () => {
    const actor = await identity(appA);
    const suffix = randomUUID().slice(0, 8);
    const workspace = await request(appA.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ name: `Presence ${suffix}`, slug: `presence-${suffix}` })
      .expect(201);
    const workspaceId = workspace.body.workspace.id as string;
    const created = await request(appA.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/notes`)
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ title: "Presence note", projectId: null, folderId: null, parentId: null })
      .expect(201);
    const noteId = created.body.note.id as string;
    const selector = { kind: "note" as const, workspaceId, noteId };

    const a = connect(listenerUrl(appA), actor.cookie);
    const b = connect(listenerUrl(appB), actor.cookie);
    const opened = [a, b];
    clients.push(...opened);
    try {
      await Promise.all([once(a, "realtime:ready"), once(b, "realtime:ready")]);
      await expect(join(a, selector)).resolves.toEqual({ ok: true });
      await expect(join(b, selector)).resolves.toEqual({ ok: true });

      const first = await presenceAnnounce(a, { selector, awarenessClientId: 11 });
      if (!first.ok) throw new Error(`A could not announce: ${first.error}`);
      expect(first.viewerCount).toBe(1);
      expect(first.presence.awarenessClientId).toBe(11);

      // The client never names itself. A frame carrying an identity key is
      // refused by the strict schema BEFORE anything is minted, so the roster
      // cannot be poisoned with a borrowed `presenceId` or a borrowed `userId`.
      const frames: { noteId: string; presence: PresenceEntry }[] = [];
      a.on("realtime:presence:joined", (frame: unknown) => {
        frames.push(presenceJoinedFrame(frame));
      });
      await expect(
        presenceAnnounce(b, { selector, awarenessClientId: 12, presenceId: randomUUID() }),
      ).resolves.toEqual({ ok: false, error: "invalid" });
      await expect(
        presenceAnnounce(b, { selector, awarenessClientId: 12, userId: first.presence.userId }),
      ).resolves.toEqual({ ok: false, error: "invalid" });

      // B's first legitimate announce doubles as the barrier for the two forged
      // ones: Socket.io preserves per-socket ordering, so anything they had
      // broadcast would already be sitting in `frames` when this frame lands.
      const joinedOnA = once(a, "realtime:presence:joined");
      const second = await presenceAnnounce(b, { selector, awarenessClientId: 12 });
      if (!second.ok) throw new Error(`B could not announce: ${second.error}`);
      const joined = presenceJoinedFrame(await joinedOnA);
      expect(frames).toHaveLength(1);
      a.off("realtime:presence:joined");

      // B is on the OTHER instance: its roster can only hold A's entry if it was
      // read across the Redis adapter, and A can only see B's arrival the same
      // way. This pair is the whole cross-instance claim.
      expect(second.viewerCount).toBe(2);
      expect(second.viewers).toHaveLength(2);
      expect(second.viewers.map((viewer) => viewer.presenceId)).toEqual(
        expect.arrayContaining([first.presence.presenceId, second.presence.presenceId]),
      );
      expect(second.presence.presenceId).not.toBe(first.presence.presenceId);
      expect(second.presence.userId).toBe(first.presence.userId);
      expect(joined).toEqual({ noteId, presence: second.presence });

      // Graceful leave: the room handler broadcasts the removal itself, and the
      // derived roster shrinks with no eviction pass in between.
      const leftOnLeave = once(a, "realtime:presence:left");
      await new Promise((resolve) => b.emit("realtime:room:leave", { selector }, resolve));
      expect(await leftOnLeave).toEqual({ noteId, presenceId: second.presence.presenceId });
      const solo = await presenceAnnounce(a, { selector, awarenessClientId: 11 });
      if (!solo.ok) throw new Error(`A could not re-announce: ${solo.error}`);
      expect(solo.viewerCount).toBe(1);
      expect(solo.viewers.map((viewer) => viewer.presenceId)).toEqual([solo.presence.presenceId]);

      // Crash/timeout path: B drops the transport without leaving. The tight
      // bound IS the assertion — it sits far below the 25 s revalidation sweep,
      // so a removal that only appeared on a timer or a TTL expiry fails here.
      await expect(join(b, selector)).resolves.toEqual({ ok: true });
      const rejoinedOnA = once(a, "realtime:presence:joined");
      const third = await presenceAnnounce(b, { selector, awarenessClientId: 13 });
      if (!third.ok) throw new Error(`B could not re-announce: ${third.error}`);
      expect(await rejoinedOnA).toEqual({ noteId, presence: third.presence });
      const leftOnCrash = once(a, "realtime:presence:left", 5_000);
      b.disconnect();
      expect(await leftOnCrash).toEqual({ noteId, presenceId: third.presence.presenceId });
      const alone = await presenceAnnounce(a, { selector, awarenessClientId: 11 });
      if (!alone.ok) throw new Error(`A could not re-announce: ${alone.error}`);
      expect(alone.viewerCount).toBe(1);
    } finally {
      for (const socket of opened) socket.disconnect();
    }
  }, 120_000);

  /**
   * Part 58 found a real cross-note corruption bug here: one app-wide socket,
   * and Socket.io dispatches by EVENT NAME rather than by room, so a socket
   * sitting in two note rooms receives both notes' frames on a single handler.
   * Presence frames inherit that hazard, which is why each one carries `noteId`
   * and why this case asserts on it — it is the regression guard, not a
   * formality. The unauthorized principal is folded in here because "conceals
   * the roster" and "labels the roster" are the same non-disclosure property.
   */
  it("labels every presence frame with its own note and conceals rosters from outsiders", async () => {
    const actor = await identity(appA);
    const suffix = randomUUID().slice(0, 8);
    const workspace = await request(appA.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ name: `Rooms ${suffix}`, slug: `rooms-${suffix}` })
      .expect(201);
    const workspaceId = workspace.body.workspace.id as string;
    const noteOne = await request(appA.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/notes`)
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ title: "Presence note one", projectId: null, folderId: null, parentId: null })
      .expect(201);
    const noteTwo = await request(appA.getHttpServer())
      .post(`/api/v1/workspaces/${workspaceId}/notes`)
      .set("Origin", origin)
      .set("Cookie", actor.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({ title: "Presence note two", projectId: null, folderId: null, parentId: null })
      .expect(201);
    const oneId = noteOne.body.note.id as string;
    const twoId = noteTwo.body.note.id as string;
    const one = { kind: "note" as const, workspaceId, noteId: oneId };
    const two = { kind: "note" as const, workspaceId, noteId: twoId };
    // Signed up BEFORE any socket opens: sign-up plus the Mailpit round trip is
    // seconds of wall clock, and these raw clients send no `realtime:heartbeat`,
    // so the gateway's staleness sweep would start reaping them mid-case.
    const outsider = await identity(appB);

    // `watcher` is the socket that holds BOTH rooms — the shape that corrupted
    // note state in Part 58.
    const watcher = connect(listenerUrl(appA), actor.cookie);
    const inOne = connect(listenerUrl(appB), actor.cookie);
    const inTwo = connect(listenerUrl(appB), actor.cookie);
    const opened = [watcher, inOne, inTwo];
    clients.push(...opened);
    try {
      await Promise.all(opened.map((socket) => once(socket, "realtime:ready")));
      await expect(join(watcher, one)).resolves.toEqual({ ok: true });
      await expect(join(watcher, two)).resolves.toEqual({ ok: true });
      await expect(join(inOne, one)).resolves.toEqual({ ok: true });
      await expect(join(inTwo, two)).resolves.toEqual({ ok: true });

      const frames: { noteId: string; presence: PresenceEntry }[] = [];
      watcher.on("realtime:presence:joined", (frame: unknown) => {
        frames.push(presenceJoinedFrame(frame));
      });

      const onOne = once(watcher, "realtime:presence:joined");
      const oneAck = await presenceAnnounce(inOne, { selector: one, awarenessClientId: 21 });
      if (!oneAck.ok) throw new Error(`presence on note one failed: ${oneAck.error}`);
      expect(await onOne).toEqual({ noteId: oneId, presence: oneAck.presence });
      const onTwo = once(watcher, "realtime:presence:joined");
      const twoAck = await presenceAnnounce(inTwo, { selector: two, awarenessClientId: 22 });
      if (!twoAck.ok) throw new Error(`presence on note two failed: ${twoAck.error}`);
      expect(await onTwo).toEqual({ noteId: twoId, presence: twoAck.presence });

      // Both frames arrived on the watcher's single handler; only `noteId`
      // separates them, so a client that trusted the handler alone would apply
      // note one's viewer to note two.
      expect(frames).toEqual([
        { noteId: oneId, presence: oneAck.presence },
        { noteId: twoId, presence: twoAck.presence },
      ]);
      // Rosters do not bleed across notes either: the watcher holds both rooms
      // but announced in neither, so each note counts exactly its own viewer.
      expect(oneAck.viewerCount).toBe(1);
      expect(twoAck.viewerCount).toBe(1);
      expect(oneAck.viewers.map((viewer) => viewer.presenceId)).toEqual([
        oneAck.presence.presenceId,
      ]);

      // A principal without `note.read` gets the same `denied` a room join
      // gives: no roster, no count, no evidence the note exists at all.
      const outsiderClient = connect(listenerUrl(appB), outsider.cookie);
      opened.push(outsiderClient);
      clients.push(outsiderClient);
      await once(outsiderClient, "realtime:ready");
      await expect(
        presenceAnnounce(outsiderClient, { selector: one, awarenessClientId: 23 }),
      ).resolves.toEqual({ ok: false, error: "denied" });

      // A fresh authorized viewer is the barrier for the denied announce: its
      // frame lands after anything the outsider could have broadcast, and its
      // roster still contains only the workspace's own members.
      const late = connect(listenerUrl(appA), actor.cookie);
      opened.push(late);
      clients.push(late);
      await once(late, "realtime:ready");
      await expect(join(late, one)).resolves.toEqual({ ok: true });
      const onLate = once(watcher, "realtime:presence:joined");
      const lateAck = await presenceAnnounce(late, { selector: one, awarenessClientId: 24 });
      if (!lateAck.ok) throw new Error(`late presence on note one failed: ${lateAck.error}`);
      expect(await onLate).toEqual({ noteId: oneId, presence: lateAck.presence });
      watcher.off("realtime:presence:joined");
      expect(frames).toHaveLength(3);
      expect(lateAck.viewerCount).toBe(2);
      expect(lateAck.viewers.map((viewer) => viewer.presenceId)).toEqual(
        expect.arrayContaining([oneAck.presence.presenceId, lateAck.presence.presenceId]),
      );
      expect(lateAck.viewers.every((viewer) => viewer.userId === oneAck.presence.userId)).toBe(
        true,
      );
    } finally {
      for (const socket of opened) socket.disconnect();
    }
  }, 120_000);

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
    /*
     * Same barrier, and here the events match so the assertion absorbs the
     * negative outright: publish the frame that must NOT arrive, then one that
     * must, and require the first thing received to be the second one. A leak
     * arrives first and fails the equality by name, rather than racing a timer.
     */
    const first = once(a, "realtime:infrastructure:probe");
    appB.get(RealtimeGateway).emitInfrastructureProbe(guessed, { nonce: "private" });
    appB.get(RealtimeGateway).emitInfrastructureProbe(selector, { nonce: "room-barrier" });
    await expect(first).resolves.toEqual({ nonce: "room-barrier" });

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
