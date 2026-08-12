import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseSearchReindexArguments,
  renderSearchReindexResult,
} from "../../scripts/search-reindex";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const INDEX_UID = "notted_prod_notes_v1";

describe("search:reindex CLI", () => {
  it("requires exactly one explicit valid selector and rejects unknown flags", () => {
    const options = { nodeEnv: "development", indexUid: "notted_dev_notes_v1" };
    expect(parseSearchReindexArguments(["--workspace-id", WORKSPACE_ID], options)).toEqual({
      kind: "workspace",
      workspaceId: WORKSPACE_ID,
    });
    expect(parseSearchReindexArguments(["--all"], options)).toEqual({ kind: "all" });
    expect(() => parseSearchReindexArguments([], options)).toThrow("exactly one");
    expect(() =>
      parseSearchReindexArguments(["--all", "--workspace-id", WORKSPACE_ID], options),
    ).toThrow("exactly one");
    expect(() => parseSearchReindexArguments(["--drop-index"], options)).toThrow("Unknown");
    expect(() => parseSearchReindexArguments(["--workspace-id", "not-a-uuid"], options)).toThrow(
      "UUID",
    );
  });

  it("requires an exact index UID confirmation in production", () => {
    expect(() =>
      parseSearchReindexArguments(["--all"], { nodeEnv: "production", indexUid: INDEX_UID }),
    ).toThrow(`--confirm-production ${INDEX_UID}`);
    expect(
      parseSearchReindexArguments(["--all", "--confirm-production", INDEX_UID], {
        nodeEnv: "production",
        indexUid: INDEX_UID,
      }),
    ).toEqual({ kind: "all" });
  });

  it("renders only safe identifiers and counts", () => {
    const output = renderSearchReindexResult({
      status: "completed",
      workspaceId: WORKSPACE_ID,
      indexUid: "notted_e2e_notes_v1",
      projected: 2,
      staleDeleted: 1,
    });
    expect(output).toContain(`workspaceId=${WORKSPACE_ID}`);
    expect(output).toContain("projected=2");
    expect(output).not.toContain("title");
    expect(output).not.toContain("content");
  });

  it("boots the dedicated context without AppModule, queues, schedulers, auth, or HTTP", () => {
    const cli = readFileSync(resolve(__dirname, "../../scripts/search-reindex.ts"), "utf8");
    const moduleSource = readFileSync(resolve(__dirname, "./search-reindex-cli.module.ts"), "utf8");
    expect(cli).toContain("createApplicationContext(SearchReindexCliModule");
    expect(cli).not.toContain("AppModule");
    expect(moduleSource).not.toMatch(/from ["']\.\.\/queue\//u);
    expect(moduleSource).not.toMatch(/from ["']\.\.\/auth\//u);
    expect(moduleSource).not.toMatch(/from ["']\.\.\/maintenance\//u);
    expect(moduleSource).not.toContain("controllers:");
  });
});
