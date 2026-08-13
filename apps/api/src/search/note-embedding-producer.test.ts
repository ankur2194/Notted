import { describe, expect, it, vi } from "vitest";

import { TenantContextService, createTenantContext } from "../tenant";

import { NoteEmbeddingProducer } from "./note-embedding-producer";

describe("NoteEmbeddingProducer", () => {
  it("deduplicates, chunks and persists identifier-only AI intents", async () => {
    const tenant = new TenantContextService();
    const values = vi.fn().mockResolvedValue(undefined);
    const tx = { insert: () => ({ values }) };
    const ids = Array.from(
      { length: 9 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await tenant.run(
      createTenantContext({ workspaceId: "00000000-0000-4000-8000-000000000099", userId: null }),
      () =>
        new NoteEmbeddingProducer(tenant).scheduleGeneration(
          tx as never,
          "00000000-0000-4000-8000-000000000099",
          [...ids, ids[0]!],
          { mutation: "test" },
        ),
    );
    expect(values).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(values.mock.calls)).not.toContain("content");
  });
});
