import { Module } from "@nestjs/common";

import { EMBEDDING_PROVIDER } from "./embedding-provider";
import { OpenAiCompatibleEmbeddingProvider } from "./openai-compatible-embedding.provider";

@Module({
  providers: [
    OpenAiCompatibleEmbeddingProvider,
    { provide: EMBEDDING_PROVIDER, useExisting: OpenAiCompatibleEmbeddingProvider },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingsModule {}
