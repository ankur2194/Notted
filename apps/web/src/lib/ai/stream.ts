import { aiStreamEventSchema } from "@notted/shared-validators";

import type { AiStreamEvent } from "@notted/shared-types";

import { apiOrigin } from "@/lib/api/api-origin";

/**
 * Part 68 — the browser's Server-Sent Events client for AI generation.
 *
 * WHY THIS IS NOT `requestJson`. The house HTTP client is wrong here twice over
 * and neither is fixable by an option:
 *
 *  1. It arms `AbortSignal.timeout(8_000)` on every request. A generation runs
 *     for tens of seconds by design, so that timer would kill essentially every
 *     one of them — and the failure would look like a network fault rather than
 *     the deadline it actually is.
 *  2. It reads the whole body with `response.json()`. An event stream has no
 *     end until the generation finishes, so that call would either hang or
 *     throw, and the deltas the user is waiting to watch arrive would never be
 *     observable at all.
 *
 * So this module owns its own `fetch`, and mirrors the rest of `requestJson`'s
 * posture deliberately: `credentials: "include"` for the session cookie,
 * `cache: "no-store"`, the same tolerance for `{code}` and `{error:{code}}`
 * envelope shapes, and `safeParse` on everything that comes off the wire.
 *
 * NOTHING HERE IS LOGGED. The request body is note text and the response is the
 * model's continuation of it; both are content this product promises not to
 * retain, so no branch below writes either to the console.
 */

export interface AiStreamCallbacks {
  onDelta: (text: string) => void;
  onDone: (info: {
    promptVersion: string;
    promptTokens: number | null;
    completionTokens: number | null;
  }) => void;
  /** Already user-facing copy — a caller renders it as-is. */
  onError: (message: string) => void;
}

export interface AiStreamHandle {
  abort: () => void;
}

/**
 * Copy for the governance refusals, keyed by the stable `ApiErrorCode` the
 * error envelope carries.
 *
 * Each one names the remedy, because every one of these has a different remedy
 * and "AI request failed" tells an author nothing they can act on: consent and
 * configuration are an admin's job in workspace settings, a quota resets on its
 * own, a rate limit clears in seconds.
 *
 * Exported so the panel can reuse the same sentence when it refuses a request
 * before making it — a disabled feature should read identically whether the
 * client or the server noticed.
 */
export const AI_FAILURE_MESSAGES = Object.freeze({
  AI_DISABLED:
    "AI features are turned off for this workspace. An owner or admin can turn them on in workspace settings.",
  AI_NOT_CONFIGURED:
    "This workspace has no AI provider set up yet. An owner or admin can configure one in workspace settings.",
  AI_CREDENTIAL_REQUIRED:
    "This workspace's AI provider has no API key saved. An owner or admin can add one in workspace settings.",
  AI_CONSENT_REQUIRED:
    "Sending note content to an AI provider has not been approved for this workspace. An owner or admin can give consent in workspace settings.",
  AI_QUOTA_EXCEEDED:
    "This workspace has used its AI allowance for today. Generation will work again after the daily quota resets.",
  AI_RATE_LIMITED: "Too many AI requests just now. Wait a few seconds and try again.",
});

/**
 * The map above looked up by an arbitrary envelope code, which is not typed.
 *
 * `Object.hasOwn`, never `in`: `in` walks the prototype chain, so an envelope
 * carrying `code: "constructor"` would pass the guard and return `Object`'s
 * constructor — a function, typed here as `string`, rendered by React. The
 * current server cannot emit that, but this is a trust boundary parsing a body
 * it did not write, and the correct check is the same length.
 */
function messageForCode(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(AI_FAILURE_MESSAGES, code)
    ? AI_FAILURE_MESSAGES[code as keyof typeof AI_FAILURE_MESSAGES]
    : undefined;
}

const PERMISSION_MESSAGE = "You do not have permission to use AI on this note.";
const UNAVAILABLE_MESSAGE = "AI is unavailable right now. Try again shortly.";
const GENERIC_MESSAGE = "The AI request could not be completed. Try again.";
/**
 * A stream that stopped without `done` or `error` was cut off mid-sentence. It
 * must never be presented as a finished answer — the text is real but partial,
 * and the user is the only one who can decide whether to keep it.
 */
const TRUNCATED_MESSAGE = "The generation was cut off before it finished. Try again.";

/** The envelope's stable code, accepting both `{code}` and `{error:{code}}`. */
async function envelopeCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const top = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    if (typeof top === "string") return top;
    const nested =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    const nestedCode =
      typeof nested === "object" && nested !== null && "code" in nested ? nested.code : undefined;
    return typeof nestedCode === "string" ? nestedCode : undefined;
  } catch {
    // No envelope, or not JSON at all: the status below is still actionable.
    return undefined;
  }
}

/**
 * Copy for a failure that happened BEFORE the response became an event stream.
 *
 * Every governance refusal lands here — they are ordinary JSON error responses,
 * never stream frames — which is why the status fallback only has to cover the
 * transport faults an envelope cannot explain.
 */
async function failureMessage(response: Response): Promise<string> {
  const mapped = messageForCode(await envelopeCode(response));
  if (mapped !== undefined) return mapped;
  const { status } = response;
  if (status === 401 || status === 403 || status === 404) return PERMISSION_MESSAGE;
  if (status === 429 || status >= 500) return UNAVAILABLE_MESSAGE;
  return GENERIC_MESSAGE;
}

/**
 * One `\n\n`-delimited frame as a validated event, or `undefined` when the frame
 * is not one.
 *
 * `undefined` is deliberately not fatal. A comment line, a heartbeat, a retry
 * directive, or one corrupted frame are all things a good stream can contain,
 * and tearing down a generation the user is watching over a single unreadable
 * frame would lose text that arrived perfectly well.
 */
function frameEvent(frame: string): AiStreamEvent | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    // Exactly one leading space after the colon is part of the framing, per the
    // SSE specification; a second space is payload and stays.
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
    .join("\n");
  if (data === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = aiStreamEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * POST `body` to `path` and stream the reply.
 *
 * At most one terminal callback (`onDone` XOR `onError`) ever fires, and none
 * at all after `abort()` — a user cancelling their own request is not a failure
 * and must not be reported as one.
 */
export function streamAi(
  path: string,
  body: unknown,
  callbacks: AiStreamCallbacks,
): AiStreamHandle {
  const controller = new AbortController();
  let settled = false;

  function settle(emit: () => void): void {
    if (settled) return;
    settled = true;
    emit();
  }

  async function run(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(new URL(path, apiOrigin()), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
      });
    } catch {
      // Offline, DNS, TLS — or our own abort, which `settle` already ignores.
      settle(() => callbacks.onError(UNAVAILABLE_MESSAGE));
      return;
    }

    if (!response.ok) {
      const message = await failureMessage(response);
      settle(() => callbacks.onError(message));
      return;
    }
    if (response.body === null) {
      settle(() => callbacks.onError(GENERIC_MESSAGE));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let terminated = false;

    try {
      while (!terminated) {
        const { done, value } = await reader.read();
        if (done) break;
        // `{ stream: true }` is what makes a multi-byte character split across
        // two chunks decode correctly instead of becoming a replacement char.
        // The trailing partial frame stays in the buffer for the next chunk:
        // a frame arriving split mid-JSON is the normal case here, not an edge.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const event = frameEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event?.type === "delta") {
            if (!settled) callbacks.onDelta(event.text);
          } else if (event?.type === "done") {
            settle(() => callbacks.onDone(event));
            terminated = true;
            break;
          } else if (event?.type === "error") {
            settle(() => callbacks.onError(event.message));
            terminated = true;
            break;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      settle(() => callbacks.onError(UNAVAILABLE_MESSAGE));
      return;
    } finally {
      // Releases the connection when we stopped early; a no-op once it drained.
      void reader.cancel().catch(() => undefined);
    }

    if (!terminated) settle(() => callbacks.onError(TRUNCATED_MESSAGE));
  }

  void run();

  return {
    abort: () => {
      settled = true;
      controller.abort();
    },
  };
}
