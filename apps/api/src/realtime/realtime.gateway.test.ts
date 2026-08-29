import { describe, expect, it, vi } from "vitest";

import { RealtimeRoomService } from "./realtime-room.service";
import { RealtimeGateway } from "./realtime.gateway";

const config = {
  path: "/socket.io",
  pingIntervalMs: 30_000,
  pingTimeoutMs: 70_000,
  revalidationIntervalMs: 25_000,
  maxHttpBufferSize: 262_144,
  maxRoomsPerSocket: 32,
  preAuthAttemptsPerMinute: 30,
  authenticatedAttemptsPerMinute: 120,
  joinsPerMinute: 60,
  maxConcurrentSockets: 8,
  updatesPerMinute: 900,
  awarenessPerMinute: 900,
  maxUpdateBytes: 131_072,
  maxAwarenessBytes: 8_192,
  maxCollaborationStateBytes: 4_194_304,
  maxPresencePerRoom: 50,
  presenceAnnouncesPerMinute: 30,
};

const selector = {
  kind: "note" as const,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  noteId: "00000000-0000-4000-8000-000000000002",
};

/** A second note on the same workspace, so teardown can be asserted per room. */
const otherSelector = {
  kind: "note" as const,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  noteId: "00000000-0000-4000-8000-000000000003",
};

/** `room()` is a pure sha256 of the selector, so the test can name rooms too. */
const roomNames = new RealtimeRoomService();

const syncResult = {
  ok: true,
  epoch: 2,
  revision: 7,
  schemaVersion: 1,
  update: new Uint8Array(),
  stateVector: new Uint8Array(),
};

function varUint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0b0111_1111) {
    bytes.push(0b1000_0000 | (remaining & 0b0111_1111));
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

/** One awareness entry: varUint(count) varUint(clientID) varUint(clock) varString(""). */
function awarenessFrame(clientId: number): Uint8Array {
  return new Uint8Array([...varUint(1), ...varUint(clientId), ...varUint(1), ...varUint(0)]);
}

function remotePeer(room: string, index: number) {
  return {
    data: {
      presence: {
        [room]: {
          presenceId: `presence-${index}`,
          userId: `user-${index}`,
          colorIndex: index % 8,
          awarenessClientId: 1_000 + index,
        },
      },
    },
  };
}

const principal = {
  userId: "u",
  sessionId: "s",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function socket() {
  const relay = vi.fn();
  return {
    id: "socket",
    request: { rawHeaders: ["cookie", "session=safe-test-value"] },
    data: {},
    on: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: relay }),
    relay,
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    emit: vi.fn(),
  };
}

type Handler = (input: unknown, ack?: (result: unknown) => void) => void;

function handlerFor(client: ReturnType<typeof socket>, event: string): Handler {
  const calls = client.on.mock.calls as [string, Handler][];
  const handler = calls.find(([name]) => name === event)?.[1];
  if (handler === undefined) throw new Error(`No handler registered for ${event}`);
  return handler;
}

function invoke(handler: Handler, input: unknown): Promise<unknown> {
  return new Promise((resolve) => handler(input, resolve));
}

function harness(overrides?: {
  readonly authorizeSocketMessage?: ReturnType<typeof vi.fn>;
  readonly authorizeSocketJoin?: ReturnType<typeof vi.fn>;
  readonly collaboration?: Record<string, ReturnType<typeof vi.fn>>;
  /** `(tier, key, limit) => boolean`, so a test can starve one tier only. */
  readonly allow?: ReturnType<typeof vi.fn>;
}) {
  const client = socket();
  const authorizeSocketMessage = overrides?.authorizeSocketMessage ?? vi.fn().mockResolvedValue({});
  const authorizeSocketJoin = overrides?.authorizeSocketJoin ?? vi.fn().mockResolvedValue({});
  const allow = overrides?.allow ?? vi.fn().mockResolvedValue(true);
  const collaboration = {
    sync: vi.fn(),
    applyUpdate: vi.fn(),
    ...overrides?.collaboration,
  };
  const projections = { schedule: vi.fn() };
  // The roster is read with `server.in(room).fetchSockets()`. Defaulting to the
  // announcing socket itself models the local instance, which really does see
  // its own socket in the result — that is what makes a re-announce find its
  // own previous row rather than a stale peer.
  const remote: { value: readonly { readonly data: unknown }[] } = { value: [client] };
  const serverEmit = vi.fn();
  const fetchSockets = vi.fn(() => Promise.resolve(remote.value));
  const fakeServer = {
    in: vi.fn(() => ({ fetchSockets })),
    to: vi.fn(() => ({ emit: serverEmit })),
  };
  const gateway = new RealtimeGateway(
    { authenticateHeaders: vi.fn().mockResolvedValue(principal) } as never,
    { authorizeSocketMessage, authorizeSocketJoin } as never,
    new RealtimeRoomService(),
    {
      allow,
      acquireSocketLease: vi.fn().mockResolvedValue(true),
      releaseSocketLease: vi.fn().mockResolvedValue(undefined),
    } as never,
    { isReady: () => true } as never,
    config,
    collaboration as never,
    projections as never,
    { collaborationEnabled: true } as never,
  );
  // `@WebSocketServer()` is a Nest PROPERTY decorator with no runtime injection
  // when the gateway is built with a plain `new`, and `afterInit()` only hands
  // the io server to the room service — neither sets `this.server`. The harness
  // assigns it directly so the presence roster read has something to talk to.
  Object.assign(gateway, { server: fakeServer });
  return {
    client,
    gateway,
    allow,
    authorizeSocketMessage,
    authorizeSocketJoin,
    collaboration,
    projections,
    remote,
    serverEmit,
    fetchSockets,
  };
}

/** Joins a note room the way a collaborative client does, via the handshake. */
function joinNoteAck(
  test: ReturnType<typeof harness>,
  target: typeof selector | typeof otherSelector,
): Promise<unknown> {
  return invoke(handlerFor(test.client, "realtime:note:sync"), {
    selector: target,
    schemaVersion: 1,
    stateVector: new Uint8Array(),
  });
}

async function joinNote(
  test: ReturnType<typeof harness>,
  target: typeof selector | typeof otherSelector,
): Promise<void> {
  await joinNoteAck(test, target);
}

describe("RealtimeGateway", () => {
  it("completes connection and reauthorizes permission-sensitive messages", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await test.gateway.authorizeMessage(
      test.client as never,
      { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000001" },
      "workspace.read",
    );

    expect(test.client.on).toHaveBeenCalledTimes(7);
    expect(test.authorizeSocketMessage).toHaveBeenCalledOnce();
    expect(test.gateway).not.toHaveProperty("broadcast");
  });

  it("memoises an authorization decision for at most one revalidation interval", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await test.gateway.authorizeMessage(test.client as never, selector, "note.read");
    await test.gateway.authorizeMessage(test.client as never, selector, "note.read");
    // A different action is a different grant and must be checked on its own.
    await test.gateway.authorizeMessage(test.client as never, selector, "note.update");
    expect(test.authorizeSocketMessage).toHaveBeenCalledTimes(2);
  });

  it("re-authorizes a handshake after a leave rather than reusing the memo", async () => {
    // join -> leave -> revoke -> re-handshake. The memo survives a leave (only
    // the revalidation sweep clears it), so a handshake that consulted it
    // re-entered the room on a decision taken before the revocation.
    const authorizeSocketJoin = vi.fn().mockResolvedValue({});
    const authorizeSocketMessage = vi.fn().mockResolvedValue({});
    const test = harness({ authorizeSocketJoin, authorizeSocketMessage });
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    await invoke(handlerFor(test.client, "realtime:room:leave"), { selector });

    // Both seams refuse, so the assertion is about the memo bypass rather than
    // about which of the two identical policy calls the handshake makes.
    authorizeSocketJoin.mockRejectedValue(new Error("revoked"));
    authorizeSocketMessage.mockRejectedValue(new Error("revoked"));
    test.client.join.mockClear();
    test.collaboration.sync.mockClear();
    const ack = await joinNoteAck(test, selector);

    expect(ack).toEqual({ ok: false, error: "denied" });
    expect(test.client.join).not.toHaveBeenCalled();
    expect(test.collaboration.sync).not.toHaveBeenCalled();
  });

  it("denies a collaborative update from a socket that never joined the room", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    const ack = await invoke(handlerFor(test.client, "realtime:note:update"), {
      selector,
      epoch: 1,
      update: new Uint8Array([1, 2, 3]),
    });
    expect(ack).toEqual({ ok: false, error: "denied" });
    expect(test.collaboration.applyUpdate).not.toHaveBeenCalled();
  });

  it("hands the handshake to the service and returns its ack verbatim", async () => {
    const result = {
      ok: true,
      epoch: 2,
      revision: 7,
      schemaVersion: 1,
      update: new Uint8Array([1]),
      stateVector: new Uint8Array([2]),
    };
    const test = harness({ collaboration: { sync: vi.fn().mockResolvedValue(result) } });
    await test.gateway.handleConnection(test.client as never);
    const ack = await invoke(handlerFor(test.client, "realtime:note:sync"), {
      selector,
      schemaVersion: 1,
      stateVector: new Uint8Array(),
    });
    expect(ack).toBe(result);
    // Ordering is load-bearing: the room is joined BEFORE persisted state is read.
    expect(test.client.join).toHaveBeenCalledOnce();
    // The handshake enters a room, so it authorizes through the join seam --
    // unmemoised -- rather than the message seam.
    expect(test.authorizeSocketJoin).toHaveBeenCalledOnce();
    expect(test.authorizeSocketMessage).not.toHaveBeenCalled();
  });

  it("persists an update before acknowledging it, then relays it", async () => {
    const test = harness({
      collaboration: {
        sync: vi.fn().mockResolvedValue({
          ok: true,
          epoch: 2,
          revision: 7,
          schemaVersion: 1,
          update: new Uint8Array(),
          stateVector: new Uint8Array(),
        }),
        applyUpdate: vi.fn().mockResolvedValue({ ok: true, epoch: 2, revision: 8 }),
      },
    });
    await test.gateway.handleConnection(test.client as never);
    await invoke(handlerFor(test.client, "realtime:note:sync"), {
      selector,
      schemaVersion: 1,
      stateVector: new Uint8Array(),
    });
    const update = new Uint8Array([1, 2, 3]);
    const ack = await invoke(handlerFor(test.client, "realtime:note:update"), {
      selector,
      epoch: 2,
      update,
    });
    expect(ack).toEqual({ ok: true, epoch: 2, revision: 8 });
    expect(test.client.relay).toHaveBeenCalledWith("realtime:note:remote", {
      noteId: selector.noteId,
      epoch: 2,
      revision: 8,
      update,
    });
    expect(test.projections.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: selector.noteId, forcedBoundary: false }),
    );
  });

  it("never persists or broadcasts an update the service refused", async () => {
    const test = harness({
      collaboration: {
        sync: vi.fn().mockResolvedValue({
          ok: true,
          epoch: 2,
          revision: 7,
          schemaVersion: 1,
          update: new Uint8Array(),
          stateVector: new Uint8Array(),
        }),
        applyUpdate: vi.fn().mockResolvedValue({ ok: false, error: "stale" }),
      },
    });
    await test.gateway.handleConnection(test.client as never);
    await invoke(handlerFor(test.client, "realtime:note:sync"), {
      selector,
      schemaVersion: 1,
      stateVector: new Uint8Array(),
    });
    const ack = await invoke(handlerFor(test.client, "realtime:note:update"), {
      selector,
      epoch: 1,
      update: new Uint8Array([1]),
    });
    expect(ack).toEqual({ ok: false, error: "stale" });
    expect(test.client.relay).not.toHaveBeenCalled();
  });

  it("relays awareness without ever reaching persistence", async () => {
    const test = harness({ collaboration: { sync: vi.fn().mockResolvedValue(syncResult) } });
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    // Announce first: awareness carries a Yjs clientID, and the server only
    // relays clientIDs a presence row bound to this socket.
    await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 7,
    });
    test.client.relay.mockClear();
    const update = awarenessFrame(7);
    const ack = await invoke(handlerFor(test.client, "realtime:note:awareness"), {
      selector,
      update,
    });
    expect(ack).toEqual({ ok: true });
    expect(test.client.relay).toHaveBeenCalledWith("realtime:note:awareness", {
      noteId: selector.noteId,
      update,
    });
    expect(test.collaboration.applyUpdate).not.toHaveBeenCalled();
  });

  it("refuses awareness from a socket that joined but never announced", async () => {
    // The binding used to be enforced only WHEN a presence row existed, which
    // made the whole check opt-out: never announce, and any peer's clientID
    // could be published under.
    const test = harness({ collaboration: { sync: vi.fn().mockResolvedValue(syncResult) } });
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    const ack = await invoke(handlerFor(test.client, "realtime:note:awareness"), {
      selector,
      update: awarenessFrame(1_001),
    });
    expect(ack).toEqual({ ok: false, error: "invalid" });
    expect(test.client.relay).not.toHaveBeenCalled();
  });

  it("bounds the handshake with its own tier and never reads persisted state", async () => {
    // `note:sync` joins a room AND runs the epoch-replay transaction, so an
    // unbounded handshake is the cheapest way to make one socket do the most
    // expensive work this gateway has.
    const test = harness({
      allow: vi.fn((tier: string) => Promise.resolve(tier !== "sync")),
      collaboration: { sync: vi.fn().mockResolvedValue(syncResult) },
    });
    await test.gateway.handleConnection(test.client as never);
    const ack = await invoke(handlerFor(test.client, "realtime:note:sync"), {
      selector,
      schemaVersion: 1,
      stateVector: new Uint8Array(),
    });

    expect(ack).toEqual({ ok: false, error: "limited" });
    expect(test.collaboration.sync).not.toHaveBeenCalled();
    // Refused BEFORE the room join, so a limited socket holds no seat either.
    expect(test.client.join).not.toHaveBeenCalled();
    // Its own bucket, at the join ceiling: sharing the join counter would halve
    // the budget a legitimate reconnect (join + sync) gets.
    expect(test.allow).toHaveBeenCalledWith("sync", expect.any(String), config.joinsPerMinute);
  });

  it("rejects an oversized update frame before authorization", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    const ack = await invoke(handlerFor(test.client, "realtime:note:update"), {
      selector,
      epoch: 1,
      update: new Uint8Array(config.maxUpdateBytes + 1),
    });
    expect(ack).toEqual({ ok: false, error: "invalid" });
    expect(test.authorizeSocketMessage).not.toHaveBeenCalled();
  });

  it("registers no collaborative events when the server flag is off", async () => {
    const client = socket();
    const gateway = new RealtimeGateway(
      { authenticateHeaders: vi.fn().mockResolvedValue(principal) } as never,
      { authorizeSocketMessage: vi.fn(), authorizeSocketJoin: vi.fn() } as never,
      new RealtimeRoomService(),
      {
        allow: vi.fn().mockResolvedValue(true),
        acquireSocketLease: vi.fn().mockResolvedValue(true),
        releaseSocketLease: vi.fn().mockResolvedValue(undefined),
      } as never,
      { isReady: () => true } as never,
      config,
      { sync: vi.fn(), applyUpdate: vi.fn() } as never,
      { schedule: vi.fn() } as never,
      { collaborationEnabled: false } as never,
    );
    await gateway.handleConnection(client as never);
    // Presence is registered inside the same flag guard, so the count must stay
    // at three: join, leave, heartbeat and nothing collaborative.
    expect(client.on).toHaveBeenCalledTimes(3);
  });

  it("denies a presence announce from a socket that never joined the room", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    const ack = await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    });
    expect(ack).toEqual({ ok: false, error: "denied" });
    expect(test.fetchSockets).not.toHaveBeenCalled();
    expect(test.client.relay).not.toHaveBeenCalled();
  });

  it("denies a presence announce the note.read policy refuses", async () => {
    // Joined through `realtime:room:join` (a different policy seam) so this
    // asserts the per-announce `note.read` check rather than the room check.
    const test = harness({ authorizeSocketMessage: vi.fn().mockRejectedValue(new Error("no")) });
    await test.gateway.handleConnection(test.client as never);
    await invoke(handlerFor(test.client, "realtime:room:join"), { selector });
    const ack = await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    });
    expect(ack).toEqual({ ok: false, error: "denied" });
    expect(test.authorizeSocketMessage).toHaveBeenCalledOnce();
    expect(test.fetchSockets).not.toHaveBeenCalled();
    expect(test.client.relay).not.toHaveBeenCalled();
  });

  it("refuses to register a viewer beyond the room cap and broadcasts nothing", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    const room = roomNames.room(selector);
    test.remote.value = Array.from({ length: config.maxPresencePerRoom }, (_, index) =>
      remotePeer(room, index),
    );
    const ack = await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    });
    expect(ack).toEqual({ ok: false, error: "limited", viewerCount: 50 });
    expect(test.client.relay).not.toHaveBeenCalled();
    // Refused means unregistered: no row was written for the socket either.
    expect((test.client.data as { presence?: unknown }).presence).toBeUndefined();
  });

  it("mints the presence identity the client never supplied and returns the roster", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    const room = roomNames.room(selector);
    test.remote.value = [test.client, remotePeer(room, 1)];
    const ack = (await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    })) as {
      ok: boolean;
      presence: { presenceId: string; userId: string; colorIndex: number };
      viewers: readonly { presenceId: string }[];
      viewerCount: number;
    };

    expect(ack.ok).toBe(true);
    // The id is server-minted: the announce carried no identity at all.
    expect(ack.presence.presenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(ack.presence.userId).toBe(principal.userId);
    expect(ack.presence.colorIndex).toBeGreaterThanOrEqual(0);
    expect(ack.presence.colorIndex).toBeLessThan(8);
    // The roster includes self, and the count is the roster's own length.
    expect(ack.viewers.map((viewer) => viewer.presenceId)).toEqual([
      "presence-1",
      ack.presence.presenceId,
    ]);
    expect(ack.viewerCount).toBe(2);
    // Every server -> room presence frame carries `noteId`; one socket serves
    // the whole app and Socket.io dispatches by event name, not by room.
    expect(test.client.relay).toHaveBeenCalledWith("realtime:presence:joined", {
      noteId: selector.noteId,
      presence: ack.presence,
    });
  });

  it("retires the old row before publishing the new one on a re-announce", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    const first = (await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    })) as { presence: { presenceId: string } };
    test.client.relay.mockClear();
    // A reconnect, or an epoch reset that changes the Yjs clientID.
    const second = (await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 43,
    })) as { presence: { presenceId: string }; viewers: readonly unknown[] };

    expect(second.presence.presenceId).not.toBe(first.presence.presenceId);
    expect((test.client.relay.mock.calls as [string, unknown][]).map(([event]) => event)).toEqual([
      "realtime:presence:left",
      "realtime:presence:joined",
    ]);
    expect(test.client.relay).toHaveBeenNthCalledWith(1, "realtime:presence:left", {
      noteId: selector.noteId,
      presenceId: first.presence.presenceId,
    });
    // Replaced, not duplicated: the viewer does not accumulate a ghost row.
    expect(second.viewers).toHaveLength(1);
  });

  it("refuses an awareness frame published under a clientID the socket never bound", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    });
    test.client.relay.mockClear();
    const ack = await invoke(handlerFor(test.client, "realtime:note:awareness"), {
      selector,
      update: awarenessFrame(43),
    });
    expect(ack).toEqual({ ok: false, error: "invalid" });
    expect(test.client.relay).not.toHaveBeenCalled();
  });

  it("still relays an awareness frame published under the bound clientID", async () => {
    const test = harness();
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    });
    test.client.relay.mockClear();
    const update = awarenessFrame(42);
    const ack = await invoke(handlerFor(test.client, "realtime:note:awareness"), {
      selector,
      update,
    });
    expect(ack).toEqual({ ok: true });
    expect(test.client.relay).toHaveBeenCalledWith("realtime:note:awareness", {
      noteId: selector.noteId,
      update,
    });
  });

  it("retires presence in every joined room when the socket goes away", async () => {
    const test = harness({ collaboration: { sync: vi.fn().mockResolvedValue(syncResult) } });
    await test.gateway.handleConnection(test.client as never);
    await joinNote(test, selector);
    const first = (await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector,
      awarenessClientId: 42,
    })) as { presence: { presenceId: string } };
    await joinNote(test, otherSelector);
    const second = (await invoke(handlerFor(test.client, "realtime:presence:announce"), {
      selector: otherSelector,
      awarenessClientId: 43,
    })) as { presence: { presenceId: string } };

    await test.gateway.handleDisconnect(test.client as never);

    // `cleanup()` clears `state.notes` via `scheduleBoundary`, so the noteIds
    // must have been captured first — two rooms, two addressed frames.
    expect(test.serverEmit).toHaveBeenCalledTimes(2);
    expect(test.serverEmit).toHaveBeenCalledWith("realtime:presence:left", {
      noteId: selector.noteId,
      presenceId: first.presence.presenceId,
    });
    expect(test.serverEmit).toHaveBeenCalledWith("realtime:presence:left", {
      noteId: otherSelector.noteId,
      presenceId: second.presence.presenceId,
    });
    expect(test.client.data).toEqual({ presence: undefined, principal: undefined });
  });

  it.each(["revoked session", "adapter outage"])("fails closed for %s", async (scenario) => {
    const client = socket();
    const gateway = new RealtimeGateway(
      {
        authenticateHeaders: vi
          .fn()
          .mockResolvedValue(scenario === "revoked session" ? null : principal),
      } as never,
      {} as never,
      new RealtimeRoomService(),
      { releaseSocketLease: vi.fn().mockResolvedValue(undefined) } as never,
      { isReady: () => scenario !== "adapter outage" } as never,
      config,
      { sync: vi.fn(), applyUpdate: vi.fn() } as never,
      { schedule: vi.fn() } as never,
      { collaborationEnabled: true } as never,
    );

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.on).not.toHaveBeenCalled();
  });
});
