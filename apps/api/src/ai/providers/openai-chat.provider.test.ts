import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiChatProvider } from "./openai-chat.provider";

import type { AiChatEvent, AiChatRequest } from "./ai-chat-provider";

/**
 * Planted in every provider error body. No assertion may find it in anything
 * this adapter throws: an OpenAI error body quotes the request back, so a
 * message built from it would carry the customer's note into a log line.
 */
const MARKER = "SECRET-PROMPT-ECHO";
const ERROR_BODY = `{"error":{"message":"${MARKER}","type":"invalid_request_error"}}`;

const chatRequest: AiChatRequest = {
  model: "gpt-4o-mini",
  apiKey: "sk-test-credential",
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

async function drain(
  request: AiChatRequest = chatRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<AiChatEvent[]> {
  const events: AiChatEvent[] = [];
  for await (const event of new OpenAiChatProvider().stream(request, signal)) events.push(event);
  return events;
}

describe("OpenAiChatProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("yields deltas in order and closes with the usage totals", async () => {
    stubFetch(
      sseResponse(
        // The opening chunk announces the role with empty content; forwarding
        // it as a delta would make every consumer filter noise.
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ),
    );

    await expect(drain()).resolves.toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "usage", promptTokens: 42, completionTokens: 7 },
    ]);
  });

  it("sends the documented request and never offers the model a tool", async () => {
    const captured = stubFetch(sseResponse("data: [DONE]\n\n"));

    await drain();

    expect(captured.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headersOf(captured)).toEqual({
      Authorization: "Bearer sk-test-credential",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    expect(JSON.parse(serializedBody(captured))).toEqual({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You summarise notes." },
        { role: "user", content: "Summarise this note." },
      ],
      max_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
    });

    // Asserted on the serialized bytes, not on an object shape: this is the
    // invariant that keeps untrusted note text from reaching a tool call, and a
    // comment saying so would not survive a refactor.
    expect(serializedBody(captured)).not.toContain("tools");
    expect(serializedBody(captured)).not.toContain("tool_choice");
    expect(serializedBody(captured)).not.toContain("functions");
  });

  it("omits temperature when the caller did not pick one", async () => {
    const captured = stubFetch(sseResponse("data: [DONE]\n\n"));

    await drain({ ...chatRequest, temperature: undefined });

    expect(serializedBody(captured)).not.toContain("temperature");
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

  it("skips a chunk it cannot parse instead of failing the whole stream", async () => {
    stubFetch(
      sseResponse(
        "data: {not json\n\n",
        'data: {"choices":[{"delta":{"content":"kept"}}]}\n\n',
        "data: [DONE]\n\n",
      ),
    );

    await expect(drain()).resolves.toEqual([{ type: "delta", text: "kept" }]);
  });

  it("ends quietly when the caller aborts, before or during the stream", async () => {
    stubFetch(sseResponse('data: {"choices":[{"delta":{"content":"one"}}]}\n\n'));
    await expect(drain(chatRequest, AbortSignal.abort())).resolves.toEqual([]);

    vi.unstubAllGlobals();
    stubFetch(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"one"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"two"}}]}\n\n',
      ),
    );
    const controller = new AbortController();
    const events: AiChatEvent[] = [];
    for await (const event of new OpenAiChatProvider().stream(chatRequest, controller.signal)) {
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
