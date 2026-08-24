// Part 68 — the streaming service's load-bearing guarantees.
//
// Plain object stubs, no Nest testing module: the thing under test is an
// ordering contract (authorize → acquire → resolve → only then SSE) plus a
// `finally` that must meter exactly once on every exit, and a DI container adds
// nothing to either. The fake `Response` records every call so a test can
// assert not just what was written but that NOTHING was.

import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AiGovernanceRefusal } from "./ai-governance.service";
import { buildMeetingExtractionPrompt, buildSummarizePrompt } from "./ai-prompts";
import { AiStreamService } from "./ai-stream.service";
import { AiChatProviderError, type AiChatEvent } from "./providers";

import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Response } from "express";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8100-000000000001";
const NOTE_ID = "a0000000-0000-4000-8200-000000000001";

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  isFresh: true,
});

interface FakeResponse {
  readonly response: Response;
  readonly writes: string[];
  readonly headers: Record<string, string>;
  flushed: () => number;
  ended: () => number;
  /** Simulates the reader closing the connection. */
  close: () => void;
  frames: () => unknown[];
}

function fakeResponse(): FakeResponse {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const listeners: Array<() => void> = [];
  let flushed = 0;
  let ended = 0;

  const response = {
    writableEnded: false,
    destroyed: false,
    status: vi.fn(() => response),
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return response;
    }),
    flushHeaders: vi.fn(() => {
      flushed += 1;
    }),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended += 1;
      response.writableEnded = true;
      return response;
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "close") listeners.push(listener);
      return response;
    }),
    off: vi.fn((event: string, listener: () => void) => {
      if (event === "close") {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }
      return response;
    }),
  };

  return {
    response: response as unknown as Response,
    writes,
    headers,
    flushed: () => flushed,
    ended: () => ended,
    close: () => {
      for (const listener of [...listeners]) listener();
    },
    frames: () =>
      writes.map((chunk) => {
        const match = /^data: (.*)\n\n$/su.exec(chunk);
        if (match === null) throw new Error("not an SSE data frame");
        return JSON.parse(match[1] ?? "") as unknown;
      }),
  };
}

function grantStub() {
  const recordUsage = vi.fn().mockResolvedValue(undefined);
  return {
    recordUsage,
    grant: {
      configId: "config",
      workspaceId: WORKSPACE_ID,
      provider: "openai" as const,
      model: "gpt-4o-mini",
      apiKey: "sk-test-000000000000000000000000",
      recordUsage,
    },
  };
}

/** Somewhere to park the signal that TypeScript's flow analysis can see. */
interface SignalBox {
  signal: AbortSignal | null;
}

/**
 * A provider that replays a script, stopping the moment the signal aborts —
 * which is what a real adapter's `fetch` body does.
 */
function providerStub(
  script: readonly AiChatEvent[],
  options: {
    readonly throwAfter?: Error;
    readonly box?: SignalBox;
    readonly onEvent?: (index: number) => void;
  } = {},
) {
  return {
    name: "openai" as const,
    stream: async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<AiChatEvent> {
      if (options.box !== undefined) options.box.signal = signal;
      await Promise.resolve();
      for (const [index, event] of script.entries()) {
        if (signal.aborted) return;
        options.onEvent?.(index);
        if (signal.aborted) return;
        yield event;
      }
      if (options.throwAfter !== undefined) throw options.throwAfter;
    },
  };
}

function service(overrides: {
  readonly authorizeUser?: ReturnType<typeof vi.fn>;
  readonly acquire?: ReturnType<typeof vi.fn>;
  readonly provider?: unknown;
}) {
  const authorizeUser =
    overrides.authorizeUser ?? vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID });
  const acquire = overrides.acquire ?? vi.fn();
  const resolve = vi.fn().mockReturnValue(overrides.provider ?? null);
  const instance = new AiStreamService(
    { authorizeUser } as never,
    { acquire } as never,
    { resolve } as never,
    { info: vi.fn(), failure: vi.fn() } as never,
  );
  return { instance, authorizeUser, acquire, resolve };
}

function input(response: Response) {
  return {
    principal,
    workspaceId: WORKSPACE_ID,
    noteId: NOTE_ID,
    requestId: null,
    prompt: buildSummarizePrompt({ text: "a note worth summarising", length: "brief" }),
    response,
  };
}

function completionInput(overrides: { readonly noteId?: string | null } = {}) {
  return {
    principal,
    workspaceId: WORKSPACE_ID,
    requestId: null,
    prompt: buildMeetingExtractionPrompt({ transcript: "Ana: we ship Friday." }),
    ...overrides,
  };
}

describe("AiStreamService refuses before it streams", () => {
  it("rethrows a governance refusal with nothing written to the response", async () => {
    const refusal = new AiGovernanceRefusal(
      "ai_rate_limited",
      HttpStatus.TOO_MANY_REQUESTS,
      "Too many AI requests in this workspace. Try again shortly.",
      4_500,
    );
    const fake = fakeResponse();
    const { instance } = service({ acquire: vi.fn().mockRejectedValue(refusal) });

    await expect(instance.run(input(fake.response))).rejects.toBe(refusal);

    // The whole point: the response is still an ordinary JSON response.
    expect(fake.writes).toHaveLength(0);
    expect(fake.flushed()).toBe(0);
    expect(fake.ended()).toBe(0);
    // …carrying the retry hint the refusal knew and the JSON envelope cannot hold.
    expect(fake.headers["Retry-After"]).toBe("5");
  });

  it("never reaches the governance gate when note.read is denied", async () => {
    const denied = new Error("denied");
    const fake = fakeResponse();
    const { instance, acquire } = service({
      authorizeUser: vi.fn().mockRejectedValue(denied),
      acquire: vi.fn(),
    });

    await expect(instance.run(input(fake.response))).rejects.toBe(denied);

    expect(acquire).not.toHaveBeenCalled();
    expect(fake.writes).toHaveLength(0);
    expect(fake.flushed()).toBe(0);
  });

  it("fails closed, still pre-SSE, when the grant names a provider with no adapter", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const { instance } = service({ acquire: vi.fn().mockResolvedValue(grant), provider: null });

    await expect(instance.run(input(fake.response))).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });

    expect(fake.writes).toHaveLength(0);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "ai_not_configured" }),
    );
  });
});

describe("AiStreamService happy path", () => {
  it("sets the SSE headers once, streams deltas in order, and meters one success", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([
        { type: "delta", text: "Hello" },
        { type: "usage", promptTokens: 1, completionTokens: 1 },
        { type: "delta", text: " world" },
        { type: "usage", promptTokens: 120, completionTokens: 42 },
      ]),
    });

    await instance.run(input(fake.response));

    expect(fake.headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    /*
     * `no-transform` is not cosmetic. `main.ts` installs `compression()`
     * globally and `text/event-stream` matches its `/^text\//` fallback, so
     * without this token every frame is held in a gzip buffer until the
     * response ends and nothing streams at all. This assertion is the only
     * thing standing between that regression and production.
     */
    expect(fake.headers["Cache-Control"]).toBe("no-store, no-transform");
    expect(fake.headers["Connection"]).toBe("keep-alive");
    expect(fake.headers["X-Accel-Buffering"]).toBe("no");
    expect(fake.flushed()).toBe(1);
    expect(fake.ended()).toBe(1);

    expect(fake.frames()).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
      // The LAST usage event wins; promptVersion names the prompt that ran.
      { type: "done", promptVersion: "summarize.v1", promptTokens: 120, completionTokens: 42 },
    ]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({
      status: "success",
      promptTokens: 120,
      completionTokens: 42,
    });
  });

  it("reports null tokens rather than zero when the provider never sent usage", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([{ type: "delta", text: "text" }]),
    });

    await instance.run(input(fake.response));

    expect(fake.frames()).toContainEqual({
      type: "done",
      promptVersion: "summarize.v1",
      promptTokens: null,
      completionTokens: null,
    });
    expect(recordUsage).toHaveBeenCalledWith({
      status: "success",
      promptTokens: null,
      completionTokens: null,
    });
  });
});

describe("AiStreamService failure paths", () => {
  it("turns a mid-stream provider error into one error frame and one failed row", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([{ type: "delta", text: "partial" }], {
        throwAfter: new AiChatProviderError("overloaded", true),
      }),
    });

    await instance.run(input(fake.response));

    const frames = fake.frames();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      type: "error",
      code: "ai_provider_error",
      message: "The AI provider is busy. Try again shortly.",
    });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "overloaded" }),
    );
    expect(fake.ended()).toBe(1);
  });

  it("aborts the provider and reports truncation when the character ceiling trips", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const box: SignalBox = { signal: null };
    // A brief summary budgets 300 tokens, so the server stops at 1 200 characters.
    const prompt = buildSummarizePrompt({ text: "a note", length: "brief" });
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub(
        [
          { type: "delta", text: "x".repeat(1_000) },
          { type: "delta", text: "y".repeat(1_000) },
          { type: "delta", text: "never sent" },
        ],
        { box },
      ),
    });

    await instance.run({ ...input(fake.response), prompt });

    expect(prompt.maxOutputChars).toBe(1_200);
    expect(box.signal?.aborted).toBe(true);
    expect(fake.frames()).toEqual([
      { type: "delta", text: "x".repeat(1_000) },
      {
        type: "error",
        code: "ai_output_truncated",
        message: "The generated text reached this server's length limit and was stopped.",
      },
    ]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "ai_output_truncated" }),
    );
  });

  it("calls whitespace-only output empty, and never sends a done frame for it", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([
        { type: "delta", text: "   " },
        { type: "delta", text: "\n\n" },
      ]),
    });

    await instance.run(input(fake.response));

    const frames = fake.frames();
    expect(frames.at(-1)).toEqual({
      type: "error",
      code: "ai_output_empty",
      message: "The model returned no text.",
    });
    expect(frames.some((frame) => (frame as { readonly type: string }).type === "done")).toBe(
      false,
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "ai_output_empty" }),
    );
  });

  it("aborts on client close and still meters once, with estimated completion tokens", async () => {
    const fake = fakeResponse();
    const { recordUsage, grant } = grantStub();
    const box: SignalBox = { signal: null };
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub(
        [
          { type: "delta", text: "x".repeat(400) },
          { type: "delta", text: "never seen" },
        ],
        {
          box,
          // The reader walks away after the first delta has been written.
          onEvent: (index) => {
            if (index === 1) fake.close();
          },
        },
      ),
    });

    await instance.run(input(fake.response));

    expect(box.signal?.aborted).toBe(true);
    // No terminator frame: there is nobody left to read one.
    expect(fake.frames()).toEqual([{ type: "delta", text: "x".repeat(400) }]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({
      status: "failed",
      errorCode: "client_cancelled",
      promptTokens: null,
      // 400 streamed characters at the documented four-characters-per-token estimate.
      completionTokens: 100,
    });
  });
});

/**
 * Part 69 — `complete()`, the non-streaming seam the JSON features are built on.
 *
 * It shares `run()`'s prologue and its `finally`, so what is worth asserting
 * here is that sharing: one usage row per call whatever happens, the last usage
 * event winning, and note authorization that runs if and only if a note was
 * named. The last one is the tenancy proof for the tag-suggestion route.
 */
describe("AiStreamService.complete", () => {
  it("aggregates deltas into one string and reports the last usage event", async () => {
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([
        { type: "delta", text: '{"attendees":' },
        { type: "usage", promptTokens: 1, completionTokens: 1 },
        { type: "delta", text: '["Ana"]}' },
        { type: "usage", promptTokens: 900, completionTokens: 12 },
      ]),
    });

    await expect(instance.complete(completionInput())).resolves.toEqual({
      text: '{"attendees":["Ana"]}',
      promptTokens: 900,
      completionTokens: 12,
    });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({
      status: "success",
      promptTokens: 900,
      completionTokens: 12,
    });
  });

  it("returns empty output as an empty string, metered as the success it was", async () => {
    // Deliberate: `json-repair` spends its one repair pass on this and usually
    // recovers. Failing here would burn the same provider call to less effect.
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([]),
    });

    await expect(instance.complete(completionInput())).resolves.toMatchObject({ text: "" });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("meters one failed row and throws AI_PROVIDER_ERROR on a provider failure", async () => {
    const { recordUsage, grant } = grantStub();
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([{ type: "delta", text: "partial" }], {
        throwAfter: new AiChatProviderError("overloaded", true),
      }),
    });

    await expect(instance.complete(completionInput())).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      safeResponse: {
        code: "AI_PROVIDER_ERROR",
        message: "The AI provider is busy. Try again shortly.",
      },
    });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "overloaded" }),
    );
  });

  it("aborts and fails rather than returning half a JSON document", async () => {
    const { recordUsage, grant } = grantStub();
    const box: SignalBox = { signal: null };
    const prompt = buildMeetingExtractionPrompt({ transcript: "Ana: hello." });
    const { instance } = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub(
        [
          { type: "delta", text: "x".repeat(8_000) },
          { type: "delta", text: "y" },
        ],
        { box },
      ),
    });

    await expect(instance.complete({ ...completionInput(), prompt })).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      safeResponse: { code: "AI_PROVIDER_ERROR" },
    });

    expect(prompt.maxOutputChars).toBe(8_000);
    expect(box.signal?.aborted).toBe(true);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "ai_output_truncated" }),
    );
  });

  it("authorizes note.read only when a note is named", async () => {
    const { grant } = grantStub();
    const withoutNote = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([{ type: "delta", text: "{}" }]),
    });

    await withoutNote.instance.complete(completionInput());
    expect(withoutNote.authorizeUser).not.toHaveBeenCalled();

    // …and an explicit null is the same thing as omitting it.
    await withoutNote.instance.complete(completionInput({ noteId: null }));
    expect(withoutNote.authorizeUser).not.toHaveBeenCalled();

    const withNote = service({
      acquire: vi.fn().mockResolvedValue(grant),
      provider: providerStub([{ type: "delta", text: "{}" }]),
    });
    await withNote.instance.complete(completionInput({ noteId: NOTE_ID }));

    expect(withNote.authorizeUser).toHaveBeenCalledTimes(1);
    expect(withNote.authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        action: "note.read",
        resource: { kind: "note", id: NOTE_ID },
      }),
    );
  });

  it("never reaches the provider when note.read is denied", async () => {
    const denied = new Error("denied");
    const acquire = vi.fn();
    const { instance } = service({
      authorizeUser: vi.fn().mockRejectedValue(denied),
      acquire,
    });

    await expect(instance.complete(completionInput({ noteId: NOTE_ID }))).rejects.toBe(denied);
    expect(acquire).not.toHaveBeenCalled();
  });
});
