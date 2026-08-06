import {
  DEFAULT_PAGE_MARGINS,
  DEFAULT_ZOOM,
  clampMargins,
  isValidMargin,
  isZoomSelection,
  type PageMargins,
  type ZoomSelection,
} from "./page-geometry";

/**
 * Local, per-browser viewing preferences for the note page container.
 *
 * Scope is deliberately narrow. Only the zoom level and the two margin numbers
 * are stored — never note content, never a note or workspace identifier, never
 * anything that would put tenant data in browser storage (Part 32). Both values
 * are cosmetic, so losing them costs nothing and there is no server round trip.
 * The page *size* is not stored here: it is note state, persisted through the
 * API with an expected version.
 *
 * Storage is injected rather than reached for, exactly as the Part 25 sidebar
 * preference does, so the reader stays pure and SSR-safe: callers pass `null`
 * when `window` is unavailable.
 *
 * Everything read back is untrusted. Another tab, an extension, or a stale
 * build may have written anything at all under this key, so each field is
 * validated independently and a rejected field falls back to its default rather
 * than discarding the whole record.
 */
export const PAGE_PREFERENCES_KEY = "notted.notes.page-view";

export interface PagePreferences {
  readonly zoom: ZoomSelection;
  readonly margins: PageMargins;
}

export const DEFAULT_PAGE_PREFERENCES: PagePreferences = Object.freeze({
  zoom: DEFAULT_ZOOM,
  margins: DEFAULT_PAGE_MARGINS,
});

function parseMargins(value: unknown): PageMargins {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_PAGE_MARGINS;
  }
  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  return {
    x: isValidMargin(candidate.x, "x") ? candidate.x : DEFAULT_PAGE_MARGINS.x,
    y: isValidMargin(candidate.y, "y") ? candidate.y : DEFAULT_PAGE_MARGINS.y,
  };
}

/**
 * Validate a stored payload.
 *
 * A zoom value is accepted only if it is one of the published levels or fit
 * modes; an arbitrary number is rejected rather than clamped, because the only
 * way one gets into storage is a value this application never wrote. Margins
 * are bounded by `MAX_PAGE_MARGINS`, so a stored margin can never leave a page
 * without a content column.
 */
export function parsePagePreferences(raw: string | null): PagePreferences {
  if (raw === null) return DEFAULT_PAGE_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PAGE_PREFERENCES;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_PAGE_PREFERENCES;
  }
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  return {
    zoom: isZoomSelection(record.zoom) ? record.zoom : DEFAULT_PAGE_PREFERENCES.zoom,
    margins: parseMargins(record.margins),
  };
}

export function readPagePreferences(storage: Pick<Storage, "getItem"> | null): PagePreferences {
  if (storage === null) return DEFAULT_PAGE_PREFERENCES;
  try {
    return parsePagePreferences(storage.getItem(PAGE_PREFERENCES_KEY));
  } catch {
    return DEFAULT_PAGE_PREFERENCES;
  }
}

export function writePagePreferences(
  storage: Pick<Storage, "setItem"> | null,
  value: PagePreferences,
): void {
  if (storage === null) return;
  try {
    // Written through the same shape the reader validates, and normalised
    // first, so anything persisted here reads back unchanged rather than
    // silently reverting to a default on the next load.
    storage.setItem(
      PAGE_PREFERENCES_KEY,
      JSON.stringify({
        zoom: isZoomSelection(value.zoom) ? value.zoom : DEFAULT_PAGE_PREFERENCES.zoom,
        margins: clampMargins(value.margins),
      }),
    );
  } catch {
    // Storage can be unavailable in privacy modes or full. The in-memory view
    // still works; only the preference fails to survive a reload.
  }
}

/** The browser's storage, or `null` on the server. */
export function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
