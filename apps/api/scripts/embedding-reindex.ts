import { NestFactory } from "@nestjs/core";

import { parseAiConfig } from "../src/config/ai.config";
import { EmbeddingReindexCliModule } from "../src/search/embedding-reindex-cli.module";
import { NoteEmbeddingReindexService } from "../src/search/note-embedding-reindex.service";

export function parseEmbeddingReindexArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  const clean = args.filter((value) => value !== "--");
  const workspaceIndex = clean.indexOf("--workspace-id");
  const workspaceId = clean[workspaceIndex + 1];
  if (workspaceIndex < 0 || workspaceId === undefined || !/^[0-9a-f-]{36}$/iu.test(workspaceId))
    throw new Error("Require --workspace-id <uuid>.");
  const known = new Set(["--workspace-id", workspaceId]);
  const model = parseAiConfig(environment).embeddings.model;
  if (environment.NODE_ENV === "production") {
    const confirmIndex = clean.indexOf("--confirm-production-model");
    if (clean[confirmIndex + 1] !== model)
      throw new Error(`Production reindex requires --confirm-production-model ${model}.`);
    known.add("--confirm-production-model");
    known.add(model);
  }
  if (clean.some((value) => !known.has(value)))
    throw new Error("Unknown embedding:reindex option.");
  return workspaceId;
}
async function main(): Promise<void> {
  const workspaceId = parseEmbeddingReindexArguments(process.argv.slice(2), process.env);
  const app = await NestFactory.createApplicationContext(EmbeddingReindexCliModule, {
    logger: false,
  });
  try {
    const result = await app.get(NoteEmbeddingReindexService).reindexWorkspace(workspaceId);
    process.stdout.write(
      `status=${result.status} workspaceId=${result.workspaceId} model=${result.model} scheduled=${result.scheduled}\n`,
    );
  } finally {
    await app.close();
  }
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write("Embedding reindex failed.\n");
    process.exitCode = 1;
  });
