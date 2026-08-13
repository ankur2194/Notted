import { describe, expect, it, vi } from "vitest";

import { TenantContextService } from "../tenant";

import { NoteEmbeddingJobHandler } from "./note-embedding-job-handler.service";

describe("NoteEmbeddingJobHandler", () => {
  it("disabled provider succeeds without authoritative reads", async () => {
    const repository = { loadSource: vi.fn() };
    const handler = new NoteEmbeddingJobHandler(
      {
        availability: () => "disabled",
        model: () => "m",
        dimensions: () => 1536,
        embed: vi.fn(),
      } as never,
      repository as never,
      new TenantContextService(),
      { register: vi.fn() } as never,
    );
    await handler.handle({
      outboxIntentId: "00000000-0000-4000-8000-000000000001",
      jobType: "note.embedding.generate",
      idempotencyKey: "k",
      payload: {
        action: "note.embedding.generate",
        intentId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        resourceIds: ["00000000-0000-4000-8000-000000000003"],
      },
      signal: new AbortController().signal,
    } as never);
    expect(repository.loadSource).not.toHaveBeenCalled();
  });
  it("declines stale responses through repository CAS and lets provider failures escape for retry", async () => {
    const provider = {
      availability: () => "available",
      model: () => "m",
      dimensions: () => 1536,
      embed: vi
        .fn()
        .mockResolvedValue({ vector: Array(1536).fill(0), model: "m", dimensions: 1536 }),
    };
    const repository = {
      loadSource: vi.fn().mockResolvedValue({ noteId: "n", text: "a", contentHash: "h" }),
      metadata: vi.fn().mockResolvedValue(null),
      upsertIfSourceCurrent: vi.fn().mockResolvedValue(false),
    };
    const handler = new NoteEmbeddingJobHandler(
      provider as never,
      repository as never,
      new TenantContextService(),
      { register: vi.fn() } as never,
    );
    const context = {
      outboxIntentId: "00000000-0000-4000-8000-000000000001",
      jobType: "note.embedding.generate",
      idempotencyKey: "k",
      payload: {
        action: "note.embedding.generate",
        intentId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        resourceIds: ["00000000-0000-4000-8000-000000000003"],
      },
      signal: new AbortController().signal,
    };
    await handler.handle(context as never);
    expect(repository.upsertIfSourceCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHash: "h" }),
    );
    provider.embed.mockRejectedValueOnce(new Error("raw secret provider error"));
    await expect(handler.handle(context as never)).rejects.toThrow();
  });
});
