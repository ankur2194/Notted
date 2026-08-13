// Part 52.4 — plain-text highlight rendering.
//
// The backend returns highlight snippets as PLAIN TEXT with two control
// characters around each matched term: `\u0000` starts a match and `\u0001`
// ends one. These characters cannot appear in any indexed note field, so the
// segments split cleanly without escaping. The frontend NEVER treats a snippet
// as HTML and never uses `dangerouslySetInnerHTML`: it splits on the markers
// and renders bold via React (`<mark>` for matched spans, plain text otherwise).

/** Marker placed by the backend before the first character of a matched term. */
export const HIGHLIGHT_PRE = "\u0000";
/** Marker placed by the backend after the last character of a matched term. */
export const HIGHLIGHT_POST = "\u0001";

export interface HighlightSegment {
  /** Plain-text fragment, never HTML. */
  readonly text: string;
  /** True when the fragment sits inside a `\u0000…\u0001` match pair. */
  readonly matched: boolean;
}

/**
 * Split a backend highlight snippet into ordered plain-text segments.
 *
 * Consecutive characters that share a matched/plain state are folded into one
 * segment, so adjacent markers never produce empty fragments and the component
 * maps each segment to a single `<mark>` or plain span. An unmatched opening
 * marker is tolerated (the remainder reads as matched) rather than crashing the
 * render; the contract guarantees pairs, but defensive parsing keeps a future
 * snippet shape from breaking the UI.
 */
export function renderHighlightSegments(snippet: string): readonly HighlightSegment[] {
  if (snippet.length === 0) return [];
  const segments: HighlightSegment[] = [];
  let matched = false;
  let buffer = "";
  for (let index = 0; index < snippet.length; index += 1) {
    const char = snippet[index];
    if (char === HIGHLIGHT_PRE) {
      if (buffer.length > 0) {
        segments.push({ text: buffer, matched });
        buffer = "";
      }
      matched = true;
    } else if (char === HIGHLIGHT_POST) {
      if (buffer.length > 0) {
        segments.push({ text: buffer, matched });
        buffer = "";
      }
      matched = false;
    } else {
      buffer += char;
    }
  }
  if (buffer.length > 0) segments.push({ text: buffer, matched });
  return segments;
}
