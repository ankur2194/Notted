import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readOptionalString,
  readString,
  wrapConfigError,
} from "./environment-readers";

export const AI_CONFIG = Symbol("AI_CONFIG");

export interface AiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
}

export interface AiConfig {
  readonly enabled: boolean;
  readonly openAi?: AiProviderConfig;
  readonly claude?: AiProviderConfig;
}

function provider(
  environment: Environment,
  keyName: string,
  modelName: string,
  fallbackModel: string,
): AiProviderConfig | undefined {
  const apiKey = readOptionalString(environment, keyName);
  if (apiKey === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(apiKey, "utf8") < 20) {
    throw new Error(`${keyName} must be at least 20 bytes when configured`);
  }
  return Object.freeze({
    apiKey,
    model: readString(environment, modelName, fallbackModel),
  });
}

export function parseAiConfig(environment: Environment): AiConfig {
  try {
    const enabled = readBoolean(environment, "FEATURE_AI_ENABLED", false);
    const openAi = provider(environment, "AI_OPENAI_API_KEY", "AI_OPENAI_MODEL", "gpt-4o-mini");
    const claude = provider(
      environment,
      "AI_CLAUDE_API_KEY",
      "AI_CLAUDE_MODEL",
      "claude-3-5-sonnet-latest",
    );
    if (enabled && openAi === undefined && claude === undefined) {
      throw new Error("at least one AI provider key is required when FEATURE_AI_ENABLED=true");
    }
    return Object.freeze({ enabled, openAi, claude });
  } catch (error: unknown) {
    wrapConfigError("Invalid AI configuration", error);
  }
}

@Injectable()
export class AiConfigProvider {
  readonly value = parseAiConfig(process.env);
}

export const aiConfigProvider: Provider<AiConfig> = {
  provide: AI_CONFIG,
  inject: [AiConfigProvider],
  useFactory: (provider: AiConfigProvider): AiConfig => provider.value,
};
