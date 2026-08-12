import { describe, expect, it, vi } from "vitest";

import { parseMeilisearchConfig } from "../config/meilisearch.config";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

import {
  NOTE_INDEX_SETTINGS,
  noteIndexDocumentSchema,
  noteIndexUid,
  type NoteIndexDocument,
} from "./note-index.document";
import { NoteIndexRepository } from "./note-index.repository";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type {
  MeilisearchClient,
  MeilisearchIndex,
} from "../infrastructure/meilisearch/meilisearch.tokens";

const document: NoteIndexDocument = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Search title",
  content: "Authoritative plain content",
  tags: ["planning"],
  workspaceId: "22222222-2222-4222-8222-222222222222",
  projectId: null,
  authorId: "33333333-3333-4333-8333-333333333333",
  createdAt: 1_786_406_400_000,
  updatedAt: 1_786_406_460_000,
  hasAttachments: true,
};

const logger = {
  info: vi.fn(),
  failure: vi.fn(),
} as unknown as StructuredLogger;

describe("note index contract", () => {
  it("accepts only the exact bounded document shape", () => {
    expect(noteIndexDocumentSchema.parse(document)).toEqual(document);
    expect(noteIndexDocumentSchema.safeParse({ ...document, providerScore: 0.9 }).success).toBe(
      false,
    );
    expect(noteIndexDocumentSchema.safeParse({ ...document, title: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(noteIndexDocumentSchema.safeParse({ ...document, createdAt: 1.5 }).success).toBe(false);
  });

  it("fixes the complete settings and versioned UID contract", () => {
    expect(noteIndexUid("notted_dev_")).toBe("notted_dev_notes_v1");
    expect(NOTE_INDEX_SETTINGS).toEqual({
      searchableAttributes: ["title", "tags", "content"],
      filterableAttributes: [
        "id",
        "workspaceId",
        "projectId",
        "authorId",
        "createdAt",
        "updatedAt",
        "hasAttachments",
      ],
      sortableAttributes: ["createdAt", "updatedAt"],
      displayedAttributes: [
        "id",
        "title",
        "content",
        "tags",
        "workspaceId",
        "projectId",
        "authorId",
        "createdAt",
        "updatedAt",
        "hasAttachments",
      ],
      rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
        disableOnWords: [],
        disableOnAttributes: [],
      },
    });
  });

  it("uses safe environment defaults and separates development from e2e", () => {
    expect(parseMeilisearchConfig({ NODE_ENV: "development" }).indexPrefix).toBe("notted_dev_");
    expect(parseMeilisearchConfig({ NODE_ENV: "test" }).indexPrefix).toBe("notted_test_");
    expect(
      parseMeilisearchConfig({
        NODE_ENV: "test",
        MEILISEARCH_INDEX_PREFIX: "notted_e2e_",
      }).indexPrefix,
    ).toBe("notted_e2e_");
    expect(() =>
      parseMeilisearchConfig({ NODE_ENV: "production", MEILISEARCH_INDEX_PREFIX: "notted_dev_" }),
    ).toThrow("must not use a development or test prefix");
    expect(() => parseMeilisearchConfig({ MEILISEARCH_INDEX_PREFIX: "../unsafe" })).toThrow(
      "MEILISEARCH_INDEX_PREFIX",
    );
  });

  it("applies exact settings and validates documents before the provider boundary", async () => {
    const ensureIndex = vi.fn().mockResolvedValue(undefined);
    const updateIndexSettings = vi.fn().mockResolvedValue(undefined);
    const addDocuments = vi.fn().mockResolvedValue(undefined);
    const meilisearch = {
      isEnabled: () => true,
      ensureIndex,
      updateIndexSettings,
      addDocuments,
    } as unknown as MeilisearchService;
    const repository = new NoteIndexRepository(
      parseMeilisearchConfig({ NODE_ENV: "test" }),
      meilisearch,
      logger,
    );

    await repository.ensureIndex();
    await repository.addDocuments([document]);

    expect(ensureIndex).toHaveBeenCalledWith("notted_test_notes_v1", "id");
    expect(updateIndexSettings).toHaveBeenCalledWith("notted_test_notes_v1", NOTE_INDEX_SETTINGS);
    expect(addDocuments).toHaveBeenCalledWith("notted_test_notes_v1", [document]);
    await expect(
      repository.addDocuments([{ ...document, content: "secret", extra: true } as never]),
    ).rejects.toThrow("Invalid note index documents");
    expect(addDocuments).toHaveBeenCalledTimes(1);
  });

  it("lists only UUID-filtered tenant IDs and rejects filter injection", async () => {
    const getDocumentsPage = vi.fn().mockResolvedValue({
      results: [{ id: document.id }],
      offset: 0,
      limit: 500,
      total: 1,
    });
    const repository = new NoteIndexRepository(
      parseMeilisearchConfig({ NODE_ENV: "test" }),
      { getDocumentsPage } as unknown as MeilisearchService,
      logger,
    );
    await expect(
      repository.listWorkspaceDocumentIds(document.workspaceId, { offset: 0, limit: 500 }),
    ).resolves.toMatchObject({ ids: [document.id], total: 1 });
    expect(getDocumentsPage).toHaveBeenCalledWith("notted_test_notes_v1", {
      fields: ["id"],
      filter: `workspaceId = "${document.workspaceId}"`,
      offset: 0,
      limit: 500,
    });
    await expect(
      repository.listWorkspaceDocumentIds(`${document.workspaceId}" OR true`, {
        offset: 0,
        limit: 500,
      }),
    ).rejects.toThrow("Invalid note index document ID");
    expect(getDocumentsPage).toHaveBeenCalledTimes(1);
  });
});

describe("Meilisearch task waiting", () => {
  it("waits through processing until a mutation succeeds", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValueOnce({ uid: 7, status: "processing" })
      .mockResolvedValueOnce({ uid: 7, status: "succeeded" });
    const { service, index } = createService(getTask);

    await expect(service.addDocuments("index", [document])).resolves.toBeUndefined();
    expect(index.addDocuments).toHaveBeenCalledWith([document]);
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "canceled"] as const)("rejects a %s task", async (status) => {
    const { service } = createService(vi.fn().mockResolvedValue({ uid: 7, status }));

    await expect(service.addDocuments("index", [document])).rejects.toThrow(
      "Meilisearch task_failed failed",
    );
  });

  it("bounds task waiting and redacts provider errors and document content", async () => {
    const timeoutFixture = createService(
      vi.fn(() => new Promise(() => undefined)),
      1,
    );
    await expect(timeoutFixture.service.addDocuments("index", [document])).rejects.toThrow(
      "Meilisearch task_timeout failed",
    );

    const content = "private note body api-key=secret";
    const providerFixture = createService(
      vi.fn().mockResolvedValue({ uid: 7, status: "succeeded" }),
    );
    providerFixture.index.addDocuments.mockRejectedValueOnce(new Error(content));
    let message = "";
    try {
      await providerFixture.service.addDocuments("index", [{ ...document, content }]);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Meilisearch mutation failed");
    expect(message).not.toContain(content);
  });
});

function createService(getTask: ReturnType<typeof vi.fn>, taskTimeoutMs = 100) {
  const index = {
    addDocuments: vi.fn().mockResolvedValue({ taskUid: 7 }),
  };
  const client = {
    index: vi.fn(() => index as unknown as MeilisearchIndex),
    tasks: { getTask },
  } as unknown as MeilisearchClient;
  const config = {
    ...parseMeilisearchConfig({ NODE_ENV: "test" }),
    taskTimeoutMs,
    taskPollIntervalMs: 1,
  };
  return {
    index,
    service: new MeilisearchService(config, client, logger),
  };
}
