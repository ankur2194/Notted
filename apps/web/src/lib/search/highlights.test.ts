import { describe, expect, it } from "vitest";

import { HIGHLIGHT_POST, HIGHLIGHT_PRE, renderHighlightSegments } from "./highlights";

describe("renderHighlightSegments", () => {
  it("marks the segment between a matched pair and leaves the rest plain", () => {
    const segments = renderHighlightSegments(`Ships ${HIGHLIGHT_PRE}today${HIGHLIGHT_POST} only`);
    expect(segments).toEqual([
      { text: "Ships ", matched: false },
      { text: "today", matched: true },
      { text: " only", matched: false },
    ]);
  });

  it("returns a single plain segment when the snippet has no markers", () => {
    expect(renderHighlightSegments("Release notes")).toEqual([
      { text: "Release notes", matched: false },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(renderHighlightSegments("")).toEqual([]);
  });

  it("renders several matches in order", () => {
    const snippet = `${HIGHLIGHT_PRE}one${HIGHLIGHT_POST} two ${HIGHLIGHT_PRE}three${HIGHLIGHT_POST}`;
    expect(renderHighlightSegments(snippet)).toEqual([
      { text: "one", matched: true },
      { text: " two ", matched: false },
      { text: "three", matched: true },
    ]);
  });

  it("does not produce empty fragments for adjacent markers", () => {
    const snippet = `a${HIGHLIGHT_PRE}${HIGHLIGHT_POST}b`;
    expect(renderHighlightSegments(snippet)).toEqual([
      { text: "a", matched: false },
      { text: "b", matched: false },
    ]);
  });

  it("treats a leading match as the first segment", () => {
    expect(renderHighlightSegments(`${HIGHLIGHT_PRE}top${HIGHLIGHT_POST} tail`)).toEqual([
      { text: "top", matched: true },
      { text: " tail", matched: false },
    ]);
  });

  it("tolerates an unmatched opening marker without throwing", () => {
    // The backend guarantees matched pairs, but a future snippet shape must not
    // crash the render: an unmatched opener reads the remainder as matched.
    expect(renderHighlightSegments(`plain ${HIGHLIGHT_PRE}rest`)).toEqual([
      { text: "plain ", matched: false },
      { text: "rest", matched: true },
    ]);
  });

  it("keeps a stray closing marker as plain text rather than crashing", () => {
    // The stray closer simply ends a (zero-width) match state, so the two plain
    // fragments render as adjacent plain spans rather than throwing.
    expect(renderHighlightSegments(`plain ${HIGHLIGHT_POST}rest`)).toEqual([
      { text: "plain ", matched: false },
      { text: "rest", matched: false },
    ]);
  });
});
