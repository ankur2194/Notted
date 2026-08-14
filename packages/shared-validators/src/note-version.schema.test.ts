import { describe, expect, it } from "vitest";

import {
  noteVersionListQuerySchema,
  noteVersionPageSchema,
  restoreNoteVersionSchema,
} from "./note-version.schema";

describe("note version contracts", () => {
  it("parses bounded pagination and rejects unknown fields", () => {
    expect(noteVersionListQuerySchema.parse({ limit: "20" })).toEqual({ limit: 20 });
    expect(noteVersionListQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(noteVersionListQuerySchema.safeParse({ limit: 20, hidden: true }).success).toBe(false);
  });

  it("requires a strict optimistic restore precondition", () => {
    expect(restoreNoteVersionSchema.parse({ expectedVersion: 4 })).toEqual({ expectedVersion: 4 });
    expect(restoreNoteVersionSchema.safeParse({ expectedVersion: 4, force: true }).success).toBe(
      false,
    );
  });

  it("allows only safe summary fields", () => {
    expect(
      noteVersionPageSchema.safeParse({
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            version: 2,
            title: "Checkpoint",
            author: { id: "22222222-2222-4222-8222-222222222222", name: "Writer" },
            createdAt: "2026-08-14T00:00:00.000Z",
            isCurrent: false,
            storageKey: "secret",
          },
        ],
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});
