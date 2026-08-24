// Part 67 — the provider-neutral chat/streaming seam.
//
// NO SDKs. ADR 0008 pins no AI vendor package, and the Part 53 embedding
// adapter already established the house style: hand-rolled `fetch`, a
// line-buffered SSE reader, and a closed error vocabulary. Adding `openai` or
// `@anthropic-ai/sdk` would drag in a retry policy, a telemetry client, and a
// logger we do not control, on the one code path that handles customer note
// text and a customer API key.
//
// ERRORS ARE DERIVED FROM THE HTTP STATUS AND NOTHING ELSE. A provider error
// body echoes the request back — the prompt, and with it the note content — and
// often names the account. `AiChatProviderError` therefore carries a code from
// a five-member enum and a message built from that code alone. The response
// body is never read on the failure path, never logged, and never propagated.
//
// Streaming is expressed as `AsyncIterable<AiChatEvent>` rather than a callback
// bag so a consumer can `for await` it under an `AbortSignal` and let `finally`
// run exactly once — which is what makes Part 68's "charge usage exactly once,
// even on cancel" possible without a bespoke lifecycle protocol.

import type { AiProviderErrorCode, AiProviderName } from "@notted/shared-types";

/**
 * Only `system` and `user` exist. There is no `tool` role and no `tools`
 * parameter anywhere in this module: note text is untrusted input, and a model
 * that cannot call a tool cannot be talked into calling one.
 */
export interface AiChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface AiChatRequest {
  /** Provider-specific model id, taken from the workspace config row. */
  readonly model: string;
  /** Decrypted per-workspace credential. Never logged, never persisted. */
  readonly apiKey: string;
  readonly system: string;
  readonly messages: readonly AiChatMessage[];
  /** Hard ceiling on generated tokens. Providers are asked to enforce it too. */
  readonly maxOutputTokens: number;
  readonly temperature?: number;
}

/**
 * `usage` may arrive once, several times (Anthropic splits it across
 * `message_start` and `message_delta`), or never (a stream cut short). Consumers
 * must treat the LAST usage event as authoritative and tolerate its absence.
 */
export type AiChatEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "usage"; readonly promptTokens: number; readonly completionTokens: number };

export interface AiChatProvider {
  readonly name: Exclude<AiProviderName, "disabled">;
  stream(request: AiChatRequest, signal: AbortSignal): AsyncIterable<AiChatEvent>;
}

/**
 * The only error type this module throws outward.
 *
 * `retryable` is advice for the caller's own policy; nothing in Part 67 retries
 * automatically, because a retry on a metered API is a second charge.
 */
export class AiChatProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: AiProviderErrorCode, retryable: boolean) {
    // The message is built from the CODE, never from the provider's response.
    super(`AI provider request failed (${code})`);
    this.name = "AiChatProviderError";
    this.code = code;
    this.retryable = retryable;
  }

  /**
   * Status-only mapping. Every branch is deliberate:
   * - 401/403 — the stored credential is wrong or revoked. An admin must act,
   *   so retrying is pure waste.
   * - 408/429 — back off; genuinely retryable.
   * - 5xx — the provider is unwell, not the request; retryable.
   * - any other 4xx — our request is malformed. Retrying sends the same bytes.
   * - anything else (a 1xx/3xx that reached here) is treated as transport.
   */
  static fromStatus(status: number): AiChatProviderError {
    if (status === 401 || status === 403) return new AiChatProviderError("auth", false);
    if (status === 408 || status === 429) return new AiChatProviderError("rate_limited", true);
    if (status >= 500) return new AiChatProviderError("overloaded", true);
    if (status >= 400) return new AiChatProviderError("invalid_request", false);
    return new AiChatProviderError("network", true);
  }

  /** Transport failure: DNS, TLS, socket reset, or a truncated stream. */
  static network(): AiChatProviderError {
    return new AiChatProviderError("network", true);
  }
}
