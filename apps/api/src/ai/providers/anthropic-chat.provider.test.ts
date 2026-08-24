import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicChatProvider } from "./anthropic-chat.provider";

import type { AiChatEvent, AiChatRequest } from "./ai-chat-provider";

/**
 * Planted in every provider error payload — both the HTTP error body and the
 * `error` frame's `message` field. No assertion may find it in anything this
 * adapter throws: those fields quote the request back, and the request is the
 * customer's note.
 */
const MARKER = "SECRET-PROMPT-ECHO";
const ERROR_BODY = `{"type":"error","error":{"type":"invalid_request_error","message":"${MARKER}"}}`;

const chatRequest: AiChatRequest = {
  model: "claude-3-5-haiku-latest",
  apiKey: "sk-ant-test-credential",
  system: "You summarise notes.",
  messages: [{ role: "user", content: "Summarise this note." }],
  maxOutputTokens: 256,
  temperature: 0.2,
};

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/**
 * One argument per socket read. Frames arrive in separate chunks because that
 * is how a real stream behaves, and because an abort can only take effect
 * between reads — a fixture that delivers everything at once would never
 * exercise it.
 */
function sseResponse(...payloads: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(body);
}

function stubFetch(response: Response): CapturedRequest {
  const captured: CapturedRequest = { url: "", init: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return Promise.resolve(response);
    }),
  );
  return captured;
}

function serializedBody(captured: CapturedRequest): string {
  return typeof captured.init.body === "string" ? captured.init.body : "";
}

function headersOf(captured: CapturedRequest): Record<string, string> {
  return (captured.init.headers ?? {}) as Record<string, string>;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function drain(
  request: AiChatRequest = chatRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<AiChatEvent[]> {
  const events: AiChatEvent[] = [];
  for await (const event of new AnthropicChatProvider().stream(request, signal)) events.push(event);
  return events;
}

describe("AnthropicChatProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("assembles usage across message_start and message_delta, last one authoritative", async () => {
    stubFetch(
      sseResponse(
        frame("message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 11, output_tokens: 1 } },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hel" },
        }),
        // Not prose: a non-text delta kind must never reach the consumer.
        frame("content_block_delta", {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "lo" },
        }),
        frame("message_delta", { type: "message_delta", usage: { output_tokens: 9 } }),
        frame("message_stop", { type: "message_stop" }),
      ),
    );

    const events = await drain();

    expect(events).toEqual([
      { type: "usage", promptTokens: 11, completionTokens: 1 },
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "usage", promptTokens: 11, completionTokens: 9 },
    ]);
    // The input tokens seen at `message_start` survive into the final event, so
    // a consumer that reads only the last one still bills the whole request.
    expect(events.at(-1)).toEqual({ type: "usage", promptTokens: 11, completionTokens: 9 });
  });

  it("sends the documented request and never offers the model a tool", async () => {
    const captured = stubFetch(sseResponse(frame("message_stop", { type: "message_stop" })));

    await drain();

    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf(captured)).toEqual({
      "x-api-key": "sk-ant-test-credential",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    expect(JSON.parse(serializedBody(captured))).toEqual({
      model: "claude-3-5-haiku-latest",
      messages: [{ role: "user", content: "Summarise this note." }],
      max_tokens: 256,
      stream: true,
      system: "You summarise notes.",
      temperature: 0.2,
    });

    // Asserted on the serialized bytes, not on an object shape: this is the
    // invariant that keeps untrusted note text from reaching a tool call, and a
    // comment saying so would not survive a refactor.
    expect(serializedBody(captured)).not.toContain("tools");
    expect(serializedBody(captured)).not.toContain("tool_choice");
    expect(serializedBody(captured)).not.toContain("functions");
  });

  it("lifts system messages into the top-level field instead of dropping them", async () => {
    const captured = stubFetch(sseResponse(frame("message_stop", { type: "message_stop" })));

    await drain({
      ...chatRequest,
      messages: [
        { role: "system", content: "Answer in British English." },
        { role: "user", content: "Summarise this note." },
      ],
    });

    const payload = JSON.parse(serializedBody(captured)) as Record<string, unknown>;
    expect(payload["system"]).toBe("You summarise notes.\n\nAnswer in British English.");
    // The API rejects a `role: "system"` entry, so none may survive here.
    expect(payload["messages"]).toEqual([{ role: "user", content: "Summarise this note." }]);
  });

  it("maps HTTP status to a code without ever quoting the response body", async () => {
    const cases = [
      { status: 401, code: "auth", retryable: false },
      { status: 429, code: "rate_limited", retryable: true },
      { status: 503, code: "overloaded", retryable: true },
      { status: 400, code: "invalid_request", retryable: false },
    ] as const;

    for (const expected of cases) {
      vi.unstubAllGlobals();
      stubFetch(new Response(ERROR_BODY, { status: expected.status }));

      const error: unknown = await drain().catch((cause: unknown) => cause);

      expect(error).toMatchObject({ code: expected.code, retryable: expected.retryable });
      expect((error as Error).message).not.toContain(MARKER);
      expect(String(error)).not.toContain(MARKER);
      expect(JSON.stringify(error)).not.toContain(MARKER);
    }
  });

  it("classifies an error frame from its type alone and leaks nothing from its message", async () => {
    stubFetch(
      sseResponse(
        frame("error", {
          type: "error",
          error: { type: "overloaded_error", message: MARKER },
        }),
      ),
    );

    const overloaded: unknown = await drain().catch((cause: unknown) => cause);
    expect(overloaded).toMatchObject({ code: "overloaded", retryable: true });
    expect(String(overloaded)).not.toContain(MARKER);

    vi.unstubAllGlobals();
    stubFetch(
      sseResponse(frame("error", { type: "error", error: { type: "who_knows", message: MARKER } })),
    );

    // An unclassifiable type falls back to transport rather than guessing.
    const unknownKind: unknown = await drain().catch((cause: unknown) => cause);
    expect(unknownKind).toMatchObject({ code: "network" });
    expect(String(unknownKind)).not.toContain(MARKER);
  });

  it("skips a chunk it cannot parse instead of failing the whole stream", async () => {
    stubFetch(
      sseResponse(
        "event: content_block_delta\ndata: {not json\n\n",
        frame("content_block_delta", {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "kept" },
        }),
        frame("message_stop", { type: "message_stop" }),
      ),
    );

    await expect(drain()).resolves.toEqual([{ type: "delta", text: "kept" }]);
  });

  it("ends quietly when the caller aborts, before or during the stream", async () => {
    const textFrame = (text: string): string =>
      frame("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      });

    stubFetch(sseResponse(textFrame("one")));
    await expect(drain(chatRequest, AbortSignal.abort())).resolves.toEqual([]);

    vi.unstubAllGlobals();
    stubFetch(sseResponse(textFrame("one"), textFrame("two")));
    const controller = new AbortController();
    const events: AiChatEvent[] = [];
    for await (const event of new AnthropicChatProvider().stream(chatRequest, controller.signal)) {
      events.push(event);
      controller.abort();
    }

    expect(events).toEqual([{ type: "delta", text: "one" }]);
  });

  it("treats a transport failure as retryable network, unless the caller aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNRESET"))),
    );

    await expect(drain()).rejects.toMatchObject({ code: "network", retryable: true });
    await expect(drain(chatRequest, AbortSignal.abort())).resolves.toEqual([]);
  });
});
