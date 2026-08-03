/**
 * Framework-neutral state and geometry shared by the slash-command menu and the
 * mention list. Everything here is pure so the parts that jsdom cannot exercise
 * (real caret geometry) are still covered by unit tests.
 */

export type SuggestionStatus = "loading" | "ready" | "error";

/** The only part of a `DOMRect` the popup needs, so tests need no layout. */
export interface SuggestionRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

export interface SuggestionPopupState<TItem> {
  readonly open: boolean;
  readonly query: string;
  readonly items: readonly TItem[];
  /** -1 when there is nothing to activate; never points past `items`. */
  readonly activeIndex: number;
  readonly status: SuggestionStatus;
  readonly rect: SuggestionRect | null;
}

export function emptySuggestionPopupState<TItem>(): SuggestionPopupState<TItem> {
  return { open: false, query: "", items: [], activeIndex: -1, status: "ready", rect: null };
}

/** Values the suggestion plugin hands to the popup on every lifecycle call. */
export interface SuggestionLifecycleProps<TItem> {
  readonly query: string;
  readonly clientRect?: (() => DOMRect | null) | null;
  readonly command: (item: TItem) => void;
}

export interface SuggestionSettleProps<TItem> {
  readonly query: string;
  readonly items: readonly TItem[];
  /** True when the source's own lookup failed for exactly this query. */
  readonly failed: boolean;
}

/**
 * The popup's side of the bridge. The suggestion plugin calls these; the React
 * hook implements them. Kept as an interface so the extension never imports
 * React and the hook never imports ProseMirror.
 */
export interface SuggestionSink<TItem> {
  begin(props: SuggestionLifecycleProps<TItem>): void;
  update(props: SuggestionLifecycleProps<TItem>): void;
  settle(props: SuggestionSettleProps<TItem>): void;
  exit(): void;
  /** True when the popup consumed the key; false lets the editor handle it. */
  keyDown(event: KeyboardEvent): boolean;
}

/** Wrap an active index within `count` items; returns -1 when there are none. */
export function wrapActiveIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  const base = current < 0 ? (delta < 0 ? 0 : -1) : current;
  return (((base + delta) % count) + count) % count;
}

export function readSuggestionRect(
  clientRect: (() => DOMRect | null) | null | undefined,
): SuggestionRect | null {
  if (typeof clientRect !== "function") return null;
  const rect = clientRect();
  if (rect === null) return null;
  return { top: rect.top, bottom: rect.bottom, left: rect.left };
}

export const SUGGESTION_POPUP_WIDTH = 288;
export const SUGGESTION_POPUP_MAX_HEIGHT = 288;
export const SUGGESTION_POPUP_MIN_HEIGHT = 120;
/** Distance between the caret and the popup edge. */
export const SUGGESTION_POPUP_GAP = 6;
/** Distance the popup keeps from every viewport edge. */
export const SUGGESTION_POPUP_MARGIN = 8;

export interface SuggestionViewport {
  readonly width: number;
  readonly height: number;
}

export interface SuggestionPopupGeometry {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
  readonly placement: "above" | "below";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Place the popup under the caret, flipping above it when there is not enough
 * room below, and clamp it inside the viewport on both axes. Pure so the
 * flip/clamp rules are testable without real layout.
 */
export function suggestionPopupGeometry(
  rect: SuggestionRect,
  viewport: SuggestionViewport,
): SuggestionPopupGeometry {
  const spaceBelow = viewport.height - rect.bottom - SUGGESTION_POPUP_GAP - SUGGESTION_POPUP_MARGIN;
  const spaceAbove = rect.top - SUGGESTION_POPUP_GAP - SUGGESTION_POPUP_MARGIN;
  const placement =
    spaceBelow >= SUGGESTION_POPUP_MIN_HEIGHT || spaceBelow >= spaceAbove ? "below" : "above";
  const available = placement === "below" ? spaceBelow : spaceAbove;
  const maxHeight = clamp(available, SUGGESTION_POPUP_MIN_HEIGHT, SUGGESTION_POPUP_MAX_HEIGHT);
  const top =
    placement === "below"
      ? rect.bottom + SUGGESTION_POPUP_GAP
      : Math.max(SUGGESTION_POPUP_MARGIN, rect.top - SUGGESTION_POPUP_GAP - maxHeight);
  const rightmost = Math.max(
    SUGGESTION_POPUP_MARGIN,
    viewport.width - SUGGESTION_POPUP_WIDTH - SUGGESTION_POPUP_MARGIN,
  );
  return {
    left: clamp(rect.left, SUGGESTION_POPUP_MARGIN, rightmost),
    top,
    maxHeight,
    placement,
  };
}

/**
 * Polite announcement for a suggestion popup. Screen-reader users get the
 * result count for the current query without the list stealing focus.
 */
export function suggestionAnnouncement(
  state: Pick<SuggestionPopupState<unknown>, "open" | "status" | "items" | "query">,
  nouns: { readonly singular: string; readonly plural: string },
): string {
  if (!state.open) return "";
  if (state.status === "loading") return `Searching ${nouns.plural}…`;
  if (state.status === "error") return `${nouns.plural} could not be loaded.`;
  const count = state.items.length;
  if (count === 0) {
    return state.query.length === 0
      ? `No ${nouns.plural} available.`
      : `No ${nouns.plural} match ${state.query}.`;
  }
  const noun = count === 1 ? nouns.singular : nouns.plural;
  return `${count} ${noun} available. Use the up and down arrow keys to review, Enter to insert.`;
}
