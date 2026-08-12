import { NestFactory } from "@nestjs/core";

import { parseMeilisearchConfig } from "../src/config/meilisearch.config";
import { noteIndexUid } from "../src/search/note-index.document";
import {
  NoteReindexService,
  type AllWorkspacesReindexResult,
  type WorkspaceReindexResult,
} from "../src/search/note-reindex.service";
import { SearchReindexCliModule } from "../src/search/search-reindex-cli.module";

export class SearchReindexCliError extends Error {}

export type SearchReindexSelection =
  { readonly kind: "workspace"; readonly workspaceId: string } | { readonly kind: "all" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseSearchReindexArguments(
  argumentsList: readonly string[],
  options: { readonly nodeEnv: string | undefined; readonly indexUid: string },
): SearchReindexSelection {
  const args = argumentsList.filter((value) => value !== "--");
  let workspaceId: string | undefined;
  let all = false;
  let productionConfirmation: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all") {
      if (all) throw new SearchReindexCliError("--all may be supplied only once.");
      all = true;
      continue;
    }
    if (argument === "--workspace-id" || argument === "--confirm-production") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SearchReindexCliError(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--workspace-id") {
        if (workspaceId !== undefined) {
          throw new SearchReindexCliError("--workspace-id may be supplied only once.");
        }
        workspaceId = value;
      } else {
        if (productionConfirmation !== undefined) {
          throw new SearchReindexCliError("--confirm-production may be supplied only once.");
        }
        productionConfirmation = value;
      }
      continue;
    }
    throw new SearchReindexCliError(`Unknown search:reindex option: ${argument ?? ""}`);
  }
  if ((workspaceId === undefined) === !all) {
    throw new SearchReindexCliError(
      "Require exactly one of --workspace-id <uuid> or explicit --all.",
    );
  }
  if (workspaceId !== undefined && !UUID_PATTERN.test(workspaceId)) {
    throw new SearchReindexCliError("--workspace-id must be a UUID.");
  }
  if (options.nodeEnv === "production") {
    if (productionConfirmation !== options.indexUid) {
      throw new SearchReindexCliError(
        `Production reindex requires --confirm-production ${options.indexUid}.`,
      );
    }
  } else if (productionConfirmation !== undefined) {
    throw new SearchReindexCliError("--confirm-production is accepted only in production.");
  }
  return workspaceId === undefined ? { kind: "all" } : { kind: "workspace", workspaceId };
}

export function renderSearchReindexResult(
  result: WorkspaceReindexResult | AllWorkspacesReindexResult,
): string {
  const common = [`status=${result.status}`, `indexUid=${result.indexUid}`];
  if ("workspaceId" in result) {
    return [
      ...common,
      `workspaceId=${result.workspaceId}`,
      `projected=${result.projected}`,
      `staleDeleted=${result.staleDeleted}`,
    ].join(" ");
  }
  return [
    ...common,
    `workspacesReindexed=${result.workspacesReindexed}`,
    `projected=${result.projected}`,
    `staleDeleted=${result.staleDeleted}`,
    `orphanWorkspacesPurged=${result.orphanWorkspacesPurged}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const indexUid = noteIndexUid(parseMeilisearchConfig(process.env).indexPrefix);
  const selection = parseSearchReindexArguments(process.argv.slice(2), {
    nodeEnv: process.env.NODE_ENV,
    indexUid,
  });
  const app = await NestFactory.createApplicationContext(SearchReindexCliModule, { logger: false });
  try {
    const service = app.get(NoteReindexService);
    const result =
      selection.kind === "workspace"
        ? await service.reindexWorkspace(selection.workspaceId)
        : await service.reindexAllWorkspaces();
    process.stdout.write(`${renderSearchReindexResult(result)}\n`);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof SearchReindexCliError
        ? `${error.message}\n`
        : "Search reindex failed. Inspect redacted application logs for the failure category.\n",
    );
    process.exitCode = 1;
  });
}
