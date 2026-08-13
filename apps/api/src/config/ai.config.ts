import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readEnum,
  readInteger,
  readOptionalString,
  readString,
  readUrl,
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
  readonly embeddings: EmbeddingConfig;
}

export interface EmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: "openai-compatible";
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly dimensions: 1536;
  readonly maxSourceCharacters: number;
  readonly requestTimeoutMs: number;
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
    const embeddingEnabled = readBoolean(environment, "FEATURE_EMBEDDINGS_ENABLED", false);
    const embeddingApiKey = readOptionalString(environment, "EMBEDDING_API_KEY");
    if (embeddingEnabled && embeddingApiKey === undefined) {
      throw new Error("EMBEDDING_API_KEY is required when FEATURE_EMBEDDINGS_ENABLED=true");
    }
    if (embeddingApiKey !== undefined && Buffer.byteLength(embeddingApiKey, "utf8") < 20) {
      throw new Error("EMBEDDING_API_KEY must be at least 20 bytes when configured");
    }
    const dimensions = readInteger(environment, "EMBEDDING_DIMENSIONS", 1536, 1, 65535);
    if (dimensions !== 1536) {
      throw new Error("EMBEDDING_DIMENSIONS must be exactly 1536");
    }
    const embeddings: EmbeddingConfig = Object.freeze({
      enabled: embeddingEnabled,
      provider: readEnum(
        environment,
        "EMBEDDING_PROVIDER",
        ["openai-compatible"] as const,
        "openai-compatible",
      ),
      baseUrl: readUrl(environment, "EMBEDDING_BASE_URL", {
        fallback: "https://api.openai.com/v1",
        allowedProtocols: ["https:", "http:"],
      })
        .toString()
        .replace(/\/$/u, ""),
      ...(embeddingApiKey === undefined ? {} : { apiKey: embeddingApiKey }),
      model: readString(environment, "EMBEDDING_MODEL", "text-embedding-3-small"),
      dimensions: 1536,
      maxSourceCharacters: readInteger(
        environment,
        "EMBEDDING_MAX_SOURCE_CHARACTERS",
        24000,
        256,
        1000000,
      ),
      requestTimeoutMs: readInteger(
        environment,
        "EMBEDDING_REQUEST_TIMEOUT_MS",
        30000,
        1000,
        120000,
      ),
    });
    if (enabled && openAi === undefined && claude === undefined) {
      throw new Error("at least one AI provider key is required when FEATURE_AI_ENABLED=true");
    }
    return Object.freeze({ enabled, openAi, claude, embeddings });
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
