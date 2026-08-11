/**
 * Span derivation and lane packing for the project timeline (Part 49.3).
 *
 * Deliberately generic and free of React, network and product types: the
 * component maps a project, its notes and its tasks into `TimelineItem`s and
 * this module only knows about labelled start/end pairs. That is what keeps the
 * overlap and missing-date rules testable without rendering anything.
 *
 * Two invariants the callers depend on:
 *
 * - **Nothing is ever dropped.** An item with no usable start becomes an
 *   `unscheduled` entry, never a silently missing row.
 * - **No end is ever invented.** A missing, unparseable, equal or
 *   earlier-than-start end produces a marker at the start, never a bar reaching
 *   "today", and never a negative width.
 */

export type TimelineKind = "project" | "note" | "task";

/** One record, before any date has been parsed. */
export interface TimelineItem {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly label: string;
  readonly start: string | null;
  readonly end: string | null;
}

/** One record that had a usable start, placed on a non-overlapping lane. */
export interface TimelineSpan {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  /** True when there is no distinct end: drawn as a pip at `startMs`. */
  readonly marker: boolean;
  readonly lane: number;
}

export interface TimelineLayout {
  readonly spans: readonly TimelineSpan[];
  readonly unscheduled: readonly TimelineItem[];
  readonly lanes: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** A span whose lane has not been chosen yet. */
type PlacedSpan = Omit<TimelineSpan, "lane">;

function parseMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The full tie-break chain, so identical input always yields identical lanes. */
function byStart(a: PlacedSpan, b: PlacedSpan): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || a.label.localeCompare(b.label);
}

/**
 * Places every item that has a usable start onto the fewest lanes that keep
 * lane-mates from overlapping, and partitions the rest into `unscheduled`.
 *
 * Greedy first-fit over a start-ordered list, which is optimal for interval
 * graphs — the lane count it produces equals the maximum number of spans
 * overlapping at any instant. The tie-break chain (start, then end, then label)
 * exists so the same input always yields the same lanes and the same row order.
 *
 * `<` rather than `<=` on the fit test: two spans that merely touch at an
 * instant would render as one continuous bar on a shared lane, so they are kept
 * apart.
 */
export function layoutTimeline(items: readonly TimelineItem[]): TimelineLayout {
  const unscheduled: TimelineItem[] = [];
  const placed: PlacedSpan[] = [];

  for (const item of items) {
    const startMs = parseMs(item.start);
    if (startMs === null) {
      unscheduled.push(item);
      continue;
    }
    // An end at or before the start carries no duration. Clamping it to the
    // start is what makes a negative width unrepresentable rather than merely
    // unlikely, and `marker` then falls out of the clamp instead of restating it.
    const parsedEnd = parseMs(item.end);
    const endMs = parsedEnd === null || parsedEnd <= startMs ? startMs : parsedEnd;
    placed.push({
      id: item.id,
      kind: item.kind,
      label: item.label,
      startMs,
      endMs,
      marker: endMs === startMs,
    });
  }

  placed.sort(byStart);

  const laneEnds: number[] = [];
  const spans = placed.map((span) => {
    const found = laneEnds.findIndex((end) => end < span.startMs);
    const lane = found === -1 ? laneEnds.length : found;
    // Safe to overwrite rather than max(): the list is start-ordered and this
    // lane only accepted the span because its previous end precedes this start.
    laneEnds[lane] = span.endMs;
    return { ...span, lane };
  });

  return {
    spans,
    unscheduled,
    lanes: laneEnds.length,
    // Already sorted by start, so the first span IS the minimum.
    minMs: spans[0]?.startMs ?? 0,
    maxMs: spans.length === 0 ? 0 : Math.max(...spans.map((span) => span.endMs)),
  };
}

/**
 * Where a span sits on the axis, as percentages of the layout's full range.
 *
 * A zero-width range (one span, or several markers at the same instant) yields
 * `left: 0`, so a division by zero can never reach the DOM as an unparsable
 * `width`. Markers legitimately return `width: 0` and are given their visible
 * size by a CSS minimum, not by a fabricated duration.
 */
export function spanBounds(
  span: TimelineSpan,
  layout: TimelineLayout,
): { readonly left: number; readonly width: number } {
  const range = layout.maxMs - layout.minMs;
  if (range <= 0) return { left: 0, width: 0 };
  return {
    left: ((span.startMs - layout.minMs) / range) * 100,
    width: ((span.endMs - span.startMs) / range) * 100,
  };
}
