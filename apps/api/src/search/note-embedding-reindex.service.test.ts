import { describe, expect, it, vi } from "vitest";

import { NoteEmbeddingReindexService } from "./note-embedding-reindex.service";

import type { DatabaseService } from "../database/database.service";
import type { EmbeddingProvider } from "../infrastructure/embeddings/embedding-provider";
import type { TenantContextService } from "../tenant";
import type { NoteEmbeddingProducer } from "./note-embedding-producer";
import type { NoteEmbeddingRepository } from "./note-embedding.repository";

describe("NoteEmbeddingReindexService", () => {
  it("continues through a clean page and schedules stale notes from a later page", async () => {
    const stalePage = vi
      .fn()
      .mockResolvedValueOnce({ noteIds: [], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ noteIds: ["11111111-1111-4111-8111-111111111111"] });
    const scheduleGeneration = vi.fn().mockResolvedValue(undefined);
    const service = new NoteEmbeddingReindexService(
      {
        availability: () => "available",
        model: () => "text-embedding-3-small",
        dimensions: () => 1536,
        embed: vi.fn(),
      } as unknown as EmbeddingProvider,
      { stalePage } as unknown as NoteEmbeddingRepository,
      { scheduleGeneration } as unknown as NoteEmbeddingProducer,
      {
        transaction: vi.fn(async (work: (tx: unknown) => Promise<void>) => work({})),
      } as unknown as DatabaseService,
      {
        run: vi.fn((_context: unknown, work: () => unknown) => work()),
      } as unknown as TenantContextService,
    );

    const result = await service.reindexWorkspace("22222222-2222-4222-8222-222222222222");

    expect(stalePage).toHaveBeenCalledTimes(2);
    expect(stalePage).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: "cursor-1" }));
    expect(scheduleGeneration).toHaveBeenCalledTimes(1);
    expect(result.scheduled).toBe(1);
  });

  it("is disabled without scanning or scheduling", async () => {
    const stalePage = vi.fn();
    const scheduleGeneration = vi.fn();
    const service = new NoteEmbeddingReindexService(
      {
        availability: () => "disabled",
        model: () => "text-embedding-3-small",
        dimensions: () => 1536,
        embed: vi.fn(),
      } as unknown as EmbeddingProvider,
      { stalePage } as unknown as NoteEmbeddingRepository,
      { scheduleGeneration } as unknown as NoteEmbeddingProducer,
      { transaction: vi.fn() } as unknown as DatabaseService,
      { run: vi.fn() } as unknown as TenantContextService,
    );

    await expect(
      service.reindexWorkspace("22222222-2222-4222-8222-222222222222"),
    ).resolves.toMatchObject({ status: "disabled", scheduled: 0 });
    expect(stalePage).not.toHaveBeenCalled();
    expect(scheduleGeneration).not.toHaveBeenCalled();
  });
});
