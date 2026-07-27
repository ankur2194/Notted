import { Module } from "@nestjs/common";

import { MEILISEARCH_CONFIG, type MeilisearchConfig } from "../../config/meilisearch.config";

import { MeilisearchService } from "./meilisearch.service";
import { MEILISEARCH_CLIENT, type MeilisearchClient } from "./meilisearch.tokens";

interface ImportedMeilisearchModule {
  readonly Meilisearch: new (options: {
    readonly host: string;
    readonly apiKey?: string;
    readonly timeout: number;
  }) => MeilisearchClient;
}

// meilisearch 0.60 is ESM-only while Nest 10 currently emits CommonJS.
// Indirect native import keeps the package's reviewed ESM entry point intact.
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<ImportedMeilisearchModule>;

@Module({
  providers: [
    {
      provide: MEILISEARCH_CLIENT,
      inject: [MEILISEARCH_CONFIG],
      useFactory: async (config: MeilisearchConfig): Promise<MeilisearchClient | null> => {
        if (!config.enabled) {
          return null;
        }
        const { Meilisearch } = await importEsm("meilisearch");
        return new Meilisearch({
          host: config.host,
          apiKey: config.apiKey,
          timeout: config.requestTimeoutMs,
        });
      },
    },
    MeilisearchService,
  ],
  exports: [MeilisearchService],
})
export class MeilisearchModule {}
