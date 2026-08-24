import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AI_FAILURE_MESSAGES, streamAi } from "./stream";

/**
 * The subject reads a raw byte stream it pulls itself, so the double is a
 * `Response` whose reader yields exactly the `Uint8Array` chunks each test
 * chooses. That is the only way to control the one thing that matters here:
 * WHERE the chunk boundaries fall relative to the frame boundaries.
 */
function reader(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read: () => {
      const chunk = chunks[index];
      index += 1;
      return Promise.resolve(
        chunk === undefined
          ? { done: true, value: undefined }
          : { done: false, value: encoder.encode(chunk) },
      );
    },
    cancel: () => Promise.resolve(),
  };
}

function streamResponse(chunks: readonly string[]): Response {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader(chunks) },
    json: () => Promise.reject(new Error("an event stream is not JSON")),
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    body: null,
    json: () =>
      body === undefined ? Promise.reject(new Error("no envelope")) : Promise.resolve(body),
  } as unknown as Response;
}

function respondWith(response: Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callbacks() {
  return { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
}

/**
 * Every promise in the fake reader resolves immediately, so one macrotask
 * boundary drains the whole chain of microtasks the parser runs on.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const doneFrame =
  'data: {"type":"done","promptVersion":"summarize.v1","promptTokens":120,"completionTokens":48}\n\n';

describe("streamAi", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts an event-stream request with the session cookie and an abort signal", async () => {
    const fetchMock = respondWith(streamResponse([doneFrame]));
    const handlers = callbacks();
    streamAi("/api/v1/workspaces/w/ai/summarize", { noteId: "n" }, handlers);
    await settled();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/workspaces/w/ai/summarize");
    expect(init.method).toBe("POST");
    // The 8s deadline and JSON parse in `requestJson` are exactly why this
    // module owns its own fetch; the rest of that client's posture is kept.
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(JSON.stringify({ noteId: "n" }));
  });

  it("reassembles a frame delivered in two chunks split mid-JSON", async () => {
    respondWith(streamResponse(['data: {"type":"del', 'ta","text":"Hello"}\n\n', doneFrame]));
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    expect(handlers.onDelta.mock.calls).toEqual([["Hello"]]);
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
  });

  it("parses several frames arriving in a single chunk, in order", async () => {
    respondWith(
      streamResponse([
        'data: {"type":"delta","text":"one "}\n\ndata: {"type":"delta","text":"two"}\n\n',
        doneFrame,
      ]),
    );
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    expect(handlers.onDelta.mock.calls).toEqual([["one "], ["two"]]);
  });

  it("ends on a done frame, once, carrying the token counts", async () => {
    respondWith(streamResponse([doneFrame, 'data: {"type":"delta","text":"late"}\n\n']));
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    expect(handlers.onDone.mock.calls).toEqual([
      [{ type: "done", promptVersion: "summarize.v1", promptTokens: 120, completionTokens: 48 }],
    ]);
    expect(handlers.onError).not.toHaveBeenCalled();
    // Nothing may follow a terminator, not even a delta the server still sent.
    expect(handlers.onDelta).not.toHaveBeenCalled();
  });

  it("stops on an error frame and surfaces its message", async () => {
    respondWith(
      streamResponse([
        'data: {"type":"delta","text":"partial"}\n\n',
        'data: {"type":"error","code":"ai_provider_error","message":"The AI provider stopped responding."}\n\n',
        doneFrame,
      ]),
    );
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    expect(handlers.onDelta).toHaveBeenCalledWith("partial");
    expect(handlers.onError.mock.calls).toEqual([["The AI provider stopped responding."]]);
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it("skips a malformed or off-contract frame without tearing down a good stream", async () => {
    respondWith(
      streamResponse([
        ": heartbeat\n\n",
        "data: {oops\n\n",
        'data: {"type":"unknown","text":"x"}\n\n',
        'data: {"type":"delta"}\n\n',
        'data: {"type":"delta","text":"survived"}\n\n',
        doneFrame,
      ]),
    );
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    expect(handlers.onDelta.mock.calls).toEqual([["survived"]]);
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("reads a `data:` line with or without the optional single space", async () => {
    respondWith(
      streamResponse([
        'data:{"type":"delta","text":"  spaced  "}\n\n',
        'data: {"type":"delta","text":"tight"}\n\n',
        doneFrame,
      ]),
    );
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    // Only the framing space is removed; whitespace inside the payload is text.
    expect(handlers.onDelta.mock.calls).toEqual([["  spaced  "], ["tight"]]);
  });

  it("treats a stream that ends with no terminator as cut off, never as complete", async () => {
    respondWith(streamResponse(['data: {"type":"delta","text":"half a sen"}\n\n']));
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();

    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(String(handlers.onError.mock.calls[0]?.[0])).toContain("cut off");
  });

  it("maps a governance refusal that arrived before the stream to its own copy", async () => {
    respondWith(errorResponse(403, { code: "AI_CONSENT_REQUIRED" }));
    const flat = callbacks();
    streamAi("/ai/summarize", {}, flat);
    await settled();
    expect(flat.onError).toHaveBeenCalledWith(AI_FAILURE_MESSAGES.AI_CONSENT_REQUIRED);

    // The envelope is written in two shapes across this API; both are read.
    respondWith(errorResponse(403, { error: { code: "AI_CONSENT_REQUIRED" } }));
    const nested = callbacks();
    streamAi("/ai/summarize", {}, nested);
    await settled();
    expect(nested.onError).toHaveBeenCalledWith(AI_FAILURE_MESSAGES.AI_CONSENT_REQUIRED);
  });

  it.each([
    ["AI_DISABLED", 403],
    ["AI_NOT_CONFIGURED", 409],
    ["AI_QUOTA_EXCEEDED", 429],
    ["AI_RATE_LIMITED", 429],
  ] as const)("maps %s ahead of the status fallback", async (code, status) => {
    respondWith(errorResponse(status, { code }));
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();
    expect(handlers.onError).toHaveBeenCalledWith(AI_FAILURE_MESSAGES[code]);
  });

  it.each([
    [401, "permission"],
    [404, "permission"],
    [429, "shortly"],
    [503, "shortly"],
    [418, "could not be completed"],
  ])("falls back on HTTP %s when no envelope code explains it", async (status, fragment) => {
    respondWith(errorResponse(status, undefined));
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();
    expect(String(handlers.onError.mock.calls[0]?.[0])).toContain(fragment);
  });

  it("reports a missing body rather than assuming an empty generation", async () => {
    respondWith({ ok: true, status: 200, body: null } as unknown as Response);
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it("reports a network failure as transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const handlers = callbacks();
    streamAi("/ai/summarize", {}, handlers);
    await settled();
    expect(String(handlers.onError.mock.calls[0]?.[0])).toContain("Try again shortly");
  });

  it("fires nothing at all after abort — a user cancelling is not a failure", async () => {
    let release: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const handlers = callbacks();
    const handle = streamAi("/ai/summarize", {}, handlers);

    handle.abort();
    // The response lands after the cancel: the reader still runs, and still
    // must not report a delta, a completion, or an error to a gone caller.
    release(streamResponse(['data: {"type":"delta","text":"ignored"}\n\n', doneFrame]));
    await settled();

    expect(handlers.onDelta).not.toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});
