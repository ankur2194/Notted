import { describe, expect, it, vi } from "vitest";

import {
  clearRecentSearches,
  normalizeRecentQuery,
  RECENT_SEARCH_LIMIT,
  readRecentSearches,
  recordRecentSearch,
} from "./recent-searches";

const workspaceId = "51000000-0000-4000-8000-000000000001";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("normalizeRecentQuery", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeRecentQuery("  release   notes ")).toBe("release notes");
  });

  it("rejects empty and whitespace-only queries", () => {
    expect(normalizeRecentQuery("")).toBeNull();
    expect(normalizeRecentQuery("   ")).toBeNull();
  });

  it("rejects queries longer than the cap", () => {
    expect(normalizeRecentQuery("x".repeat(501))).toBeNull();
    expect(normalizeRecentQuery("x".repeat(500))).toBe("x".repeat(500));
  });
});

describe("readRecentSearches", () => {
  it("returns an empty list when storage is null", () => {
    expect(readRecentSearches(workspaceId, null)).toEqual([]);
  });

  it("returns an empty list when nothing is stored", () => {
    expect(readRecentSearches(workspaceId, memoryStorage())).toEqual([]);
  });

  it("returns an empty list when the payload is corrupt or wrong-version", () => {
    const storage = memoryStorage();
    storage.setItem(
      `notted.search.recents.${workspaceId}`,
      JSON.stringify({ items: [{ query: "x" }], version: 2 }),
    );
    expect(readRecentSearches(workspaceId, storage)).toEqual([]);
    storage.setItem(`notted.search.recents.${workspaceId}`, "not-json");
    expect(readRecentSearches(workspaceId, storage)).toEqual([]);
  });

  it("returns items newest first and caps at the limit", () => {
    const storage = memoryStorage();
    const items = Array.from({ length: RECENT_SEARCH_LIMIT + 3 }, (_unused, index) => ({
      query: `q${index}`,
      recordedAt: `2026-08-01T00:00:0${index % 10}.000Z`,
    }));
    storage.setItem(`notted.search.recents.${workspaceId}`, JSON.stringify({ items, version: 1 }));
    const result = readRecentSearches(workspaceId, storage);
    expect(result).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(result[0]?.query).toBe("q0");
  });

  it("treats a throwing storage as unavailable", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readRecentSearches(workspaceId, throwing)).toEqual([]);
  });
});

describe("recordRecentSearch", () => {
  it("prepends a new query and persists it", () => {
    const storage = memoryStorage();
    const first = recordRecentSearch(workspaceId, "release notes", storage);
    expect(first).toEqual([{ query: "release notes", recordedAt: expect.any(String) }]);
    const second = recordRecentSearch(workspaceId, "roadmap", storage);
    expect(second.map((item) => item.query)).toEqual(["roadmap", "release notes"]);
    // Persistence round-trips through the schema.
    expect(readRecentSearches(workspaceId, storage).map((item) => item.query)).toEqual([
      "roadmap",
      "release notes",
    ]);
  });

  it("moves an identical query to the front without duplicating", () => {
    const storage = memoryStorage();
    recordRecentSearch(workspaceId, "alpha", storage);
    recordRecentSearch(workspaceId, "beta", storage);
    recordRecentSearch(workspaceId, "gamma", storage);
    const moved = recordRecentSearch(workspaceId, "alpha", storage);
    expect(moved.map((item) => item.query)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("normalizes before comparing so only-spaces differences do not duplicate", () => {
    const storage = memoryStorage();
    recordRecentSearch(workspaceId, "release   notes", storage);
    const moved = recordRecentSearch(workspaceId, " release notes ", storage);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.query).toBe("release notes");
  });

  it("caps the list at the configured limit", () => {
    const storage = memoryStorage();
    for (let index = 0; index < RECENT_SEARCH_LIMIT + 5; index += 1) {
      recordRecentSearch(workspaceId, `q${index}`, storage);
    }
    const result = readRecentSearches(workspaceId, storage);
    expect(result).toHaveLength(RECENT_SEARCH_LIMIT);
    // Newest first: the last-recorded query leads.
    expect(result[0]?.query).toBe(`q${RECENT_SEARCH_LIMIT + 4}`);
    // The oldest entries beyond the cap were dropped.
    expect(result.find((item) => item.query === "q0")).toBeUndefined();
  });

  it("ignores an empty query and leaves the list untouched", () => {
    const storage = memoryStorage();
    recordRecentSearch(workspaceId, "alpha", storage);
    const result = recordRecentSearch(workspaceId, "   ", storage);
    expect(result.map((item) => item.query)).toEqual(["alpha"]);
  });

  it("writes a version-1 payload", () => {
    const storage = memoryStorage();
    recordRecentSearch(workspaceId, "alpha", storage);
    const raw = storage.getItem(`notted.search.recents.${workspaceId}`);
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).version).toBe(1);
  });

  it("does not throw when storage is unavailable", () => {
    const setItem = vi.fn(() => {
      throw new Error("quota");
    });
    const getItem = vi.fn(() => null);
    expect(() => recordRecentSearch(workspaceId, "alpha", { getItem, setItem })).not.toThrow();
  });

  it("is workspace-scoped", () => {
    const storage = memoryStorage();
    recordRecentSearch(workspaceId, "alpha", storage);
    const other = "51000000-0000-4000-8000-000000000002";
    recordRecentSearch(other, "beta", storage);
    expect(readRecentSearches(workspaceId, storage).map((item) => item.query)).toEqual(["alpha"]);
    expect(readRecentSearches(other, storage).map((item) => item.query)).toEqual(["beta"]);
  });
});

describe("clearRecentSearches", () => {
  it("removes the workspace key", () => {
    const storage = memoryStorage();
    recordRecentSearch(workspaceId, "alpha", storage);
    clearRecentSearches(workspaceId, storage);
    expect(readRecentSearches(workspaceId, storage)).toEqual([]);
  });

  it("does not throw when storage is null", () => {
    expect(() => clearRecentSearches(workspaceId, null)).not.toThrow();
  });
});
