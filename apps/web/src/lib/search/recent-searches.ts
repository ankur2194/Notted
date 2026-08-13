// Part 52.4 — browser-local recent searches, workspace-scoped.
//
// The backend never persists or transports recent searches; this module owns
// the localStorage shape so it stays stable and a future sync surface could
// consume the same `RecentSearchesPayload`. Recents are keyed per workspace so
// switching workspaces shows a different history. The try/catch discipline
// mirrors `sidebar-preference.ts`: storage may be unavailable in privacy modes
// or quota-exceeded, and the in-memory UI keeps working in either case.

import { recentSearchSchema } from "@notted/shared-validators";

import type { RecentSearch, RecentSearchesPayload } from "@notted/shared-types";

/** Largest number of recent searches retained per workspace. */
export const RECENT_SEARCH_LIMIT = 20;
/** Payload version. Bumping invalidates older payloads via the `z.literal(1)`. */
export const RECENT_SEARCHES_VERSION = 1;
/** Hard cap on a single query length, mirroring `searchQuerySchema.query`. */
export const RECENT_SEARCH_MAX_QUERY_LENGTH = 500;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;
type RemoveStorage = Pick<Storage, "removeItem">;

function parseStoredPayload(raw: string): readonly RecentSearch[] | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== RECENT_SEARCHES_VERSION || !Array.isArray(record.items)) return null;
  // Bound work on untrusted storage while tolerating legacy overflow above the
  // current strict write/API cap of 20.
  if (record.items.length > 200) return null;
  const parsed = record.items.map((item) => recentSearchSchema.safeParse(item));
  if (parsed.some((item) => !item.success)) return null;
  return parsed.map((item) => {
    if (!item.success) throw new Error("unreachable_recent_search_parse");
    return item.data;
  });
}

function storageKey(workspaceId: string): string {
  return `notted.search.recents.${workspaceId}`;
}

/**
 * Collapse internal whitespace and trim, rejecting empty or over-long queries.
 * Returns `null` when the normalized query would not be a usable recent.
 */
export function normalizeRecentQuery(query: string): string | null {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > RECENT_SEARCH_MAX_QUERY_LENGTH) {
    return null;
  }
  return normalized;
}

/**
 * Read the workspace's recent searches, newest first.
 *
 * Storage being null, throwing, holding unparseable JSON, or failing schema
 * validation all collapse to an empty list — a corrupt or future-versioned
 * payload never breaks the palette.
 */
export function readRecentSearches(
  workspaceId: string,
  storage: ReadStorage | null,
): readonly RecentSearch[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(storageKey(workspaceId));
    if (raw === null) return [];
    const items = parseStoredPayload(raw);
    return items?.slice(0, RECENT_SEARCH_LIMIT) ?? [];
  } catch {
    return [];
  }
}

function persist(workspaceId: string, storage: WriteStorage | null, items: RecentSearch[]): void {
  if (storage === null) return;
  const payload: RecentSearchesPayload = { items, version: RECENT_SEARCHES_VERSION };
  try {
    storage.setItem(storageKey(workspaceId), JSON.stringify(payload));
  } catch {
    // Quota-exceeded or privacy mode: the in-memory result is still returned so
    // the current palette session shows the recorded query.
  }
}

/**
 * Record one query at the front of the workspace's recents.
 *
 * The query is normalized first; an empty or over-long query leaves the list
 * untouched and is not persisted. An identical existing entry moves to the
 * front (no duplicates), and the list is capped at `RECENT_SEARCH_LIMIT`.
 */
export function recordRecentSearch(
  workspaceId: string,
  query: string,
  storage: WriteStorage | null,
): readonly RecentSearch[] {
  const normalized = normalizeRecentQuery(query);
  if (normalized === null) return readRecentSearches(workspaceId, storage);
  const current = readRecentSearches(workspaceId, storage);
  const remainder = current.filter((item) => item.query !== normalized);
  const entry: RecentSearch = { query: normalized, recordedAt: new Date().toISOString() };
  const items: RecentSearch[] = [entry, ...remainder].slice(0, RECENT_SEARCH_LIMIT);
  persist(workspaceId, storage, items);
  return items;
}

/** Remove every recent search for one workspace. */
export function clearRecentSearches(workspaceId: string, storage: RemoveStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(storageKey(workspaceId));
  } catch {
    // Storage may be unavailable; nothing to clear.
  }
}
