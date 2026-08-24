// Part 67 — OpenAI Chat Completions, streamed.
//
// Chat Completions rather than the Responses API: it is the endpoint every
// OpenAI-compatible gateway also implements, so a workspace pointing at a proxy
// keeps working, and its streaming shape has been stable for years.
//
// NO TOOLS. The request never carries `tools`, `tool_choice` or `functions`,
// which is why the only thing a delta can ever contain is text. Note content is
// untrusted input; a model with no tool to call cannot be argued into calling
// one. The provider tests assert the absence on the serialized body, because a
// comment does not survive a refactor and an assertion does.

import { Injectable } from "@nestjs/common";

import {
  asRecord,
  openProviderStream,
  parseJsonObject,
  readSseEvents,
  readTokenCount,
} from "./sse-stream";

import type { AiChatEvent, AiChatProvider, AiChatRequest } from "./ai-chat-provider";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

/** `choices` is an array in the payload; only the first choice is requested. */
function firstElement(value: unknown): unknown {
  return Array.isArray(value) ? (value as readonly unknown[])[0] : undefined;
}

@Injectable()
export class OpenAiChatProvider implements AiChatProvider {
  readonly name = "openai" as const;

  async *stream(request: AiChatRequest, signal: AbortSignal): AsyncGenerator<AiChatEvent> {
    const payload: Record<string, unknown> = {
      model: request.model,
      // The system prompt is ours; `request.messages` is where note text lands.
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      max_tokens: request.maxOutputTokens,
      stream: true,
      // Without this the streamed response carries no usage at all, and Part 68
      // would have to estimate tokens it is about to charge for.
      stream_options: { include_usage: true },
    };
    // Omitted rather than defaulted: the provider's own default is a better
    // answer than a number this adapter would be inventing.
    if (request.temperature !== undefined) payload["temperature"] = request.temperature;

    const body = await openProviderStream(
      OPENAI_CHAT_COMPLETIONS_URL,
      {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      payload,
      signal,
    );
    if (body === null) return;

    for await (const frame of readSseEvents(body, signal)) {
      // The sentinel is not JSON, so it has to be checked before parsing.
      if (frame.data === "[DONE]") return;

      const root = parseJsonObject(frame.data);
      if (root === null) continue;

      const delta = asRecord(asRecord(firstElement(root["choices"]))?.["delta"]);
      const text = delta?.["content"];
      // Empty strings are real in this stream (the role-only opening chunk);
      // forwarding them would make every consumer filter noise.
      if (typeof text === "string" && text.length > 0) yield { type: "delta", text };

      // Arrives on its own final chunk, whose `choices` array is empty.
      const usage = asRecord(root["usage"]);
      if (usage !== null) {
        yield {
          type: "usage",
          promptTokens: readTokenCount(usage["prompt_tokens"]) ?? 0,
          completionTokens: readTokenCount(usage["completion_tokens"]) ?? 0,
        };
      }
    }
  }
}
