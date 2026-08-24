// Part 67 — Anthropic Messages, streamed.
//
// Two shapes differ from OpenAI and both are easy to get quietly wrong:
//
// 1. `system` IS A TOP-LEVEL FIELD, not a message. A `role: "system"` entry
//    left in `messages` is rejected by the API, so any that reach this adapter
//    are lifted into the top-level field instead of being dropped — losing an
//    instruction silently is worse than a slightly longer prompt.
// 2. USAGE ARRIVES IN TWO PIECES. `message_start` carries the input tokens,
//    `message_delta` the final output tokens. Neither event alone is a complete
//    bill, so this adapter keeps the running pair and re-emits it, and the
//    contract in `ai-chat-provider.ts` tells consumers the LAST one wins.
//
// NO TOOLS, for the same reason as the OpenAI adapter: note text is untrusted,
// and a model with no tool to call cannot be talked into calling one.

import { Injectable } from "@nestjs/common";

import {
  AiChatProviderError,
  type AiChatEvent,
  type AiChatProvider,
  type AiChatRequest,
} from "./ai-chat-provider";
import {
  asRecord,
  openProviderStream,
  parseJsonObject,
  readSseEvents,
  readTokenCount,
} from "./sse-stream";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Pinned. Anthropic treats this header as the API contract version. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Maps an `error` frame using its error TYPE and nothing else.
 *
 * The type is a closed vocabulary of identifiers; the sibling `message` field
 * quotes the request back — prompt, note excerpt, sometimes the account — so it
 * is never read, never logged, and never put in the thrown error.
 */
function classifyErrorFrame(root: Record<string, unknown>): AiChatProviderError {
  return asRecord(root["error"])?.["type"] === "overloaded_error"
    ? new AiChatProviderError("overloaded", true)
    : AiChatProviderError.network();
}

@Injectable()
export class AnthropicChatProvider implements AiChatProvider {
  readonly name = "anthropic" as const;

  async *stream(request: AiChatRequest, signal: AbortSignal): AsyncGenerator<AiChatEvent> {
    const system = [
      request.system,
      ...request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages
        .filter((message) => message.role === "user")
        .map((message) => ({ role: "user", content: message.content })),
      max_tokens: request.maxOutputTokens,
      stream: true,
    };
    // Omitted when empty: the API rejects an empty `system` string, and there
    // is nothing to say anyway.
    if (system.length > 0) payload["system"] = system;
    if (request.temperature !== undefined) payload["temperature"] = request.temperature;

    const body = await openProviderStream(
      ANTHROPIC_MESSAGES_URL,
      {
        "x-api-key": request.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      payload,
      signal,
    );
    if (body === null) return;

    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    for await (const frame of readSseEvents(body, signal)) {
      const root = parseJsonObject(frame.data);
      if (root === null) continue;

      // The payload's own `type` is authoritative; the SSE `event:` name is the
      // fallback for a gateway that forwards the name but not the field.
      const rawType = root["type"];
      const type = typeof rawType === "string" ? rawType : frame.event;

      let usage: Record<string, unknown> | null = null;
      switch (type) {
        case "message_start":
          usage = asRecord(asRecord(root["message"])?.["usage"]);
          break;
        case "message_delta":
          usage = asRecord(root["usage"]);
          break;
        case "content_block_delta": {
          const delta = asRecord(root["delta"]);
          const text = delta?.["text"];
          // `text_delta` is one of several delta kinds; anything else (a
          // thinking or input-JSON delta) is not model prose and is dropped.
          if (delta?.["type"] === "text_delta" && typeof text === "string" && text.length > 0) {
            yield { type: "delta", text };
          }
          break;
        }
        case "error":
          throw classifyErrorFrame(root);
        case "message_stop":
          return;
        default:
          break;
      }

      if (usage === null) continue;
      // Only a genuine change is re-emitted, so a consumer counting usage events
      // is not fooled by `message_delta` repeating what `message_start` said.
      const input = readTokenCount(usage["input_tokens"]);
      const output = readTokenCount(usage["output_tokens"]);
      let changed = false;
      if (input !== null && input !== promptTokens) {
        promptTokens = input;
        changed = true;
      }
      if (output !== null && output !== completionTokens) {
        completionTokens = output;
        changed = true;
      }
      if (changed) {
        yield {
          type: "usage",
          promptTokens: promptTokens ?? 0,
          completionTokens: completionTokens ?? 0,
        };
      }
    }
  }
}
