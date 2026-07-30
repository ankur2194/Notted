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
// Native dynamic import keeps the package's reviewed ESM entry point intact
// and resolves under both Node runtime and the Vitest runner.
async function importMeilisearch(): Promise<ImportedMeilisearchModule> {
  // TypeScript's legacy Node10 resolver cannot follow this ESM-only package's
  // export map, although Node 22 and Vitest resolve the literal import.
  // @ts-expect-error -- ESM export-map limitation under moduleResolution Node10
  return (await import("meilisearch")) as ImportedMeilisearchModule;
}

@Module({
  providers: [
    {
      provide: MEILISEARCH_CLIENT,
      inject: [MEILISEARCH_CONFIG],
      useFactory: async (config: MeilisearchConfig): Promise<MeilisearchClient | null> => {
        if (!config.enabled) {
          return null;
        }
        const { Meilisearch } = await importMeilisearch();
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
