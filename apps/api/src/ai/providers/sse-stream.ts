// Part 67 — the wire layer both chat adapters sit on: opening the streaming
// POST, framing SSE, and narrowing the untrusted JSON inside each frame.
//
// NO SSE LIBRARY. `eventsource-parser` would be a third-party package on the
// one path that carries decrypted customer note text, to save the sixty lines
// below. ADR 0008 pins the dependency set; this is a parser for a wire format
// that has not changed since 2015.
//
// Two generators rather than one state machine: `readLines` owns the socket and
// the decoder, `readSseEvents` owns the field grammar. That split is what makes
// the cleanup correct — a consumer that abandons `readSseEvents` mid-stream
// causes its `for await` to close `readLines`, whose `finally` cancels the
// reader. One inlined loop would have to duplicate that unwinding by hand.

import { AiChatProviderError } from "./ai-chat-provider";

/**
 * Ceiling on a single UNTERMINATED line.
 *
 * A response that never sends a newline would otherwise grow the buffer until
 * the process dies, and the body here is attacker-influenceable in the sense
 * that matters: we are talking to a third party over the network on behalf of a
 * tenant. Real provider frames are kilobytes; 1 MiB is far above any of them.
 */
const MAX_LINE_CHARS = 1_048_576;

/** One dispatched SSE frame. `event` is null when the stream named no type. */
export interface SseFrame {
  readonly event: string | null;
  readonly data: string;
}

function withoutTrailingCarriageReturn(line: string): string {
  // The spec allows LF, CRLF and bare CR as terminators. Splitting on LF and
  // trimming a trailing CR covers the first two; no provider emits bare CR.
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Yields complete lines from a byte stream, then the trailing partial line.
 *
 * `TextDecoder` is created in streaming mode so a multi-byte character split
 * across two socket chunks decodes once, correctly, instead of becoming two
 * replacement characters — which for an SSE payload would corrupt the JSON.
 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (!signal.aborted) {
      // A read that rejects *because the caller aborted* is not a provider
      // fault, so it must not become a retryable `network` error that some
      // future policy would act on. Everything else is a truncated stream.
      const chunk = await reader.read().catch(() => {
        if (signal.aborted) return null;
        throw AiChatProviderError.network();
      });
      if (chunk === null) return;
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        yield withoutTrailingCarriageReturn(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }

      // Checked only after draining, so `buffer` holds nothing but the current
      // unterminated tail and a long *stream* never trips the guard.
      if (buffer.length > MAX_LINE_CHARS) throw AiChatProviderError.network();
    }

    if (signal.aborted) return;

    buffer += decoder.decode();
    if (buffer.length > 0) yield withoutTrailingCarriageReturn(buffer);
  } finally {
    // Runs on normal completion, on throw, AND on the `return()` that a
    // consumer's `break` triggers. Without the cancel an aborted generation
    // leaves the provider socket open until the server times it out, which on a
    // metered API can keep billing after the user has walked away.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Parses the SSE field grammar into dispatched frames.
 *
 * Deliberately narrow: `data` and `event` are honoured, `id`/`retry`/vendor
 * extensions are ignored, and comment lines (`:` first) are dropped. Nothing
 * here ever logs `data` — it is the model's reply to a customer's note.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  let event: string | null = null;
  const data: string[] = [];

  for await (const line of readLines(body, signal)) {
    if (line === "") {
      // A frame with no `data` field carries nothing a consumer can act on;
      // dispatching it would make every adapter re-check for emptiness.
      if (data.length > 0) yield { event, data: data.join("\n") };
      event = null;
      data.length = 0;
      continue;
    }

    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one leading space is part of the framing, not the value.
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }

  // Some providers close the connection after the last `data:` line without the
  // blank line that would have dispatched it. Dropping that frame would lose
  // the final token — or the usage totals we bill on.
  if (!signal.aborted && data.length > 0) yield { event, data: data.join("\n") };
}

/**
 * Opens a streaming POST and hands back its body, or `null` when the caller
 * aborted before the response arrived.
 *
 * Shared by both adapters because the failure discipline is the part that must
 * not drift: the response body is NEVER read on the failure path — it echoes
 * the prompt back and often names the account — and is cancelled so the socket
 * is released rather than left half-consumed.
 */
export async function openProviderStream(
  url: string,
  headers: Readonly<Record<string, string>>,
  payload: unknown,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  }).catch(() => {
    // An abort is the caller's decision, not a provider fault, so it ends the
    // stream quietly instead of raising a retryable error.
    if (signal.aborted) return null;
    throw AiChatProviderError.network();
  });
  if (response === null) return null;

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw AiChatProviderError.fromStatus(response.status);
  }

  // A 200 with no body means the connection died between headers and payload.
  if (response.body === null) throw AiChatProviderError.network();
  return response.body;
}

/**
 * Every value below is a frame from a third party, so it is typed `unknown` and
 * narrowed rather than cast to a hand-written interface. A shape assertion here
 * would be a lie the first time a provider ships a schema change, and the lie
 * would surface as a `TypeError` in the middle of a user's stream.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `null` for anything that is not a JSON object, including a parse failure. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    // A frame we cannot parse is skipped, never rethrown: the raw text is the
    // model's reply, and an exception carrying it would reach a log.
    return null;
  }
}

/**
 * A token count, or `null` when absent or nonsensical.
 *
 * Negative and fractional values are rejected rather than clamped — they mean
 * we misread the payload, and a wrong number here becomes a wrong bill.
 */
export function readTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}
