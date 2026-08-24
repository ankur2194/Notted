// Part 67 — provider name to adapter, and nothing else.
//
// The exhaustive switch has no `default`. That is the point: when a fourth
// member is added to the `ai_provider` enum, this file stops compiling instead
// of routing the new provider to whichever adapter a default happened to name.

import { Injectable } from "@nestjs/common";

import { AnthropicChatProvider } from "./anthropic-chat.provider";
import { OpenAiChatProvider } from "./openai-chat.provider";

import type { AiChatProvider } from "./ai-chat-provider";
import type { AiProviderName } from "@notted/shared-types";

@Injectable()
export class AiChatProviderRegistry {
  constructor(
    private readonly openai: OpenAiChatProvider,
    private readonly anthropic: AnthropicChatProvider,
  ) {}

  /**
   * `"disabled"` resolves to `null` — the caller must fail closed, not guess.
   *
   * Returning null rather than throwing keeps the decision where the context
   * is: a governance layer answering "AI is off for this workspace" is a
   * `ai_disabled` refusal, not a provider error.
   */
  resolve(provider: AiProviderName): AiChatProvider | null {
    switch (provider) {
      case "openai":
        return this.openai;
      case "anthropic":
        return this.anthropic;
      case "disabled":
        return null;
    }
  }
}
