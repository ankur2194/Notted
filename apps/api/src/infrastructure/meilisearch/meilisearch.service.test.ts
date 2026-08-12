import { describe, expect, it, vi } from "vitest";

import { parseMeilisearchConfig } from "../../config/meilisearch.config";

import { MeilisearchService } from "./meilisearch.service";

import type { MeilisearchClient, MeilisearchIndex } from "./meilisearch.tokens";
import type { StructuredLogger } from "../../common/logging/structured-logger.service";

function fixture(
  fetchInfo: () => Promise<unknown> = vi.fn().mockResolvedValue({ uid: "notted_test_notes_v1" }),
) {
  let taskUid = 0;
  const task = () => Promise.resolve({ taskUid: ++taskUid });
  const index: MeilisearchIndex = {
    fetchInfo,
    updateSettings: vi.fn(task),
    addDocuments: vi.fn(task),
    updateDocuments: vi.fn(task),
    deleteDocuments: vi.fn(task),
    getDocuments: vi.fn().mockResolvedValue({ results: [], offset: 0, limit: 20, total: 0 }),
  };
  const client: MeilisearchClient = {
    health: vi.fn().mockResolvedValue({ status: "available" }),
    index: vi.fn().mockReturnValue(index),
    createIndex: vi.fn(task),
    tasks: { getTask: vi.fn().mockResolvedValue({ uid: 1, status: "succeeded" }) },
  };
  const service = new MeilisearchService(
    parseMeilisearchConfig({
      NODE_ENV: "test",
      MEILISEARCH_TASK_POLL_INTERVAL_MS: "10",
      MEILISEARCH_TASK_TIMEOUT_MS: "100",
    }),
    client,
    { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
  );
  return { client, index, service };
}

describe("MeilisearchService 0.60 source compatibility", () => {
  it("uses the synchronous index(uid) handle and recognizes index_not_found in cause", async () => {
    const source = fixture(() => Promise.reject({ cause: { code: "index_not_found" } }));
    await source.service.ensureIndex("notted_test_notes_v1", "id");
    expect(source.client.index).toHaveBeenCalledWith("notted_test_notes_v1");
    expect(source.client.createIndex).toHaveBeenCalledWith("notted_test_notes_v1", {
      primaryKey: "id",
    });
  });

  it("waits for tasks for settings, add/upsert, filtered delete, and ID delete", async () => {
    const source = fixture();
    await source.service.updateIndexSettings("index", { filterableAttributes: ["workspaceId"] });
    await source.service.addDocuments("index", [{ id: "a" }]);
    await source.service.updateDocuments("index", [{ id: "a" }]);
    await source.service.deleteDocumentsByFilter("index", 'workspaceId = "safe"');
    await source.service.deleteDocuments("index", ["a"]);
    expect(source.client.tasks.getTask).toHaveBeenCalledTimes(5);
    expect(source.index.deleteDocuments).toHaveBeenCalledWith({ filter: 'workspaceId = "safe"' });
    expect(source.index.deleteDocuments).toHaveBeenCalledWith(["a"]);
  });
});
