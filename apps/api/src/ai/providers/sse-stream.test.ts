import { describe, expect, it } from "vitest";

import { AiChatProviderError } from "./ai-chat-provider";
import { readSseEvents, type SseFrame } from "./sse-stream";

/**
 * Each argument is one socket read, so a test can put a line boundary anywhere
 * it likes — including in the middle of a field name, which is the case a
 * naive `split("\n")` per chunk gets wrong.
 */
function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal = new AbortController().signal,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of readSseEvents(body, signal)) frames.push(frame);
  return frames;
}

describe("readSseEvents", () => {
  it("joins repeated data fields with a newline and strips one leading space", () => {
    // The second line keeps its extra space: exactly one is framing.
    return expect(collect(streamOf("data: first\ndata:  second\ndata:third\n\n"))).resolves.toEqual(
      [{ event: null, data: "first\n second\nthird" }],
    );
  });

  it("accepts CRLF terminators and named event fields", async () => {
    const frames = await collect(
      streamOf("event: message_start\r\ndata: {}\r\n\r\nevent: ping\r\ndata: 1\r\n\r\n"),
    );

    expect(frames).toEqual([
      { event: "message_start", data: "{}" },
      { event: "ping", data: "1" },
    ]);
  });

  it("ignores comment lines, unknown fields, and frames that carry no data", async () => {
    const frames = await collect(
      streamOf(": keep-alive\nid: 7\nretry: 500\n\nevent: only-a-name\n\ndata: kept\n\n"),
    );

    // The `event: only-a-name` frame is dropped: a consumer could do nothing
    // with it, and the field name does not leak into the next frame either.
    expect(frames).toEqual([{ event: null, data: "kept" }]);
  });

  it("reassembles a line split across chunk boundaries", () => {
    return expect(collect(streamOf("da", "ta: hel", "lo\n", "\n"))).resolves.toEqual([
      { event: null, data: "hello" },
    ]);
  });

  it("flushes a trailing frame that the provider never terminated with a blank line", () => {
    return expect(collect(streamOf("data: last\n"))).resolves.toEqual([
      { event: null, data: "last" },
    ]);
  });

  it("stops at the next read once the caller aborts, and yields nothing at all when already aborted", async () => {
    const controller = new AbortController();
    const frames: SseFrame[] = [];
    for await (const frame of readSseEvents(
      streamOf("data: one\n\n", "data: two\n\n"),
      controller.signal,
    )) {
      frames.push(frame);
      controller.abort();
    }
    // Abort is a caller decision, so it ends the iteration rather than throwing.
    expect(frames).toEqual([{ event: null, data: "one" }]);

    const preAborted = AbortSignal.abort();
    await expect(collect(streamOf("data: never\n\n"), preAborted)).resolves.toEqual([]);
  });

  it("rejects a single line that exceeds the buffer ceiling", async () => {
    const error = await collect(streamOf(`data: ${"x".repeat(1_048_577)}`)).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(AiChatProviderError);
    expect(error).toMatchObject({ code: "network", retryable: true });
  });

  it("surfaces a stream read failure as a network error", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });

    await expect(collect(failing)).rejects.toMatchObject({ code: "network" });
  });
});
