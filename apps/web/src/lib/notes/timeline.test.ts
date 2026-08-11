import { describe, expect, it } from "vitest";

import { layoutTimeline, spanBounds } from "./timeline";

import type { TimelineItem } from "./timeline";

function item(id: string, start: string | null, end: string | null): TimelineItem {
  return { id, kind: "note", label: id, start, end };
}

describe("layoutTimeline", () => {
  it("stacks mutually overlapping spans onto one lane each", () => {
    const layout = layoutTimeline([
      item("a", "2026-03-01T00:00:00.000Z", "2026-03-10T00:00:00.000Z"),
      item("b", "2026-03-02T00:00:00.000Z", "2026-03-11T00:00:00.000Z"),
      item("c", "2026-03-03T00:00:00.000Z", "2026-03-12T00:00:00.000Z"),
    ]);

    expect(layout.lanes).toBe(3);
    expect(layout.spans.map((span) => [span.id, span.lane])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("packs disjoint spans onto a single lane", () => {
    const layout = layoutTimeline([
      item("a", "2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"),
      item("b", "2026-03-05T00:00:00.000Z", "2026-03-06T00:00:00.000Z"),
      item("c", "2026-03-09T00:00:00.000Z", "2026-03-10T00:00:00.000Z"),
    ]);

    expect(layout.lanes).toBe(1);
    expect(layout.spans.every((span) => span.lane === 0)).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const forward = layoutTimeline([
      item("a", "2026-03-01T00:00:00.000Z", "2026-03-10T00:00:00.000Z"),
      item("b", "2026-03-02T00:00:00.000Z", "2026-03-11T00:00:00.000Z"),
    ]);
    const reversed = layoutTimeline([
      item("b", "2026-03-02T00:00:00.000Z", "2026-03-11T00:00:00.000Z"),
      item("a", "2026-03-01T00:00:00.000Z", "2026-03-10T00:00:00.000Z"),
    ]);

    expect(reversed).toEqual(forward);
  });

  it("renders a missing end as a marker rather than inventing one", () => {
    const layout = layoutTimeline([item("a", "2026-03-01T00:00:00.000Z", null)]);

    const [span] = layout.spans;
    expect(span?.marker).toBe(true);
    expect(span?.endMs).toBe(span?.startMs);
    expect(layout.unscheduled).toEqual([]);
  });

  it("renders an unparseable end as a marker, not as a dropped record", () => {
    const layout = layoutTimeline([item("a", "2026-03-01T00:00:00.000Z", "not-a-date")]);

    expect(layout.spans).toHaveLength(1);
    expect(layout.spans[0]?.marker).toBe(true);
  });

  it("clamps an end that precedes its start to a marker, never a negative width", () => {
    const layout = layoutTimeline([
      item("backwards", "2026-03-10T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
      item("forwards", "2026-03-11T00:00:00.000Z", "2026-03-20T00:00:00.000Z"),
    ]);

    const backwards = layout.spans.find((span) => span.id === "backwards")!;
    expect(backwards.marker).toBe(true);
    expect(backwards.endMs).toBe(backwards.startMs);
    expect(spanBounds(backwards, layout).width).toBe(0);
    expect(layout.spans.every((span) => spanBounds(span, layout).width >= 0)).toBe(true);
    // The clamp must not drag the axis backwards either.
    expect(layout.minMs).toBe(Date.parse("2026-03-10T00:00:00.000Z"));
  });

  it("partitions records with no usable start into unscheduled", () => {
    const layout = layoutTimeline([
      item("dated", "2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"),
      item("undated", null, "2026-03-02T00:00:00.000Z"),
      item("unparseable", "whenever", null),
    ]);

    expect(layout.spans.map((span) => span.id)).toEqual(["dated"]);
    expect(layout.unscheduled.map((entry) => entry.id)).toEqual(["undated", "unparseable"]);
  });

  it("returns an empty axis for no input and keeps spanBounds safe", () => {
    const layout = layoutTimeline([]);

    expect(layout).toEqual({ spans: [], unscheduled: [], lanes: 0, minMs: 0, maxMs: 0 });
    expect(
      spanBounds(
        { id: "a", kind: "note", label: "a", startMs: 0, endMs: 0, marker: true, lane: 0 },
        layout,
      ),
    ).toEqual({ left: 0, width: 0 });
  });
});

describe("spanBounds", () => {
  it("maps a span onto percentages of the whole range", () => {
    const layout = layoutTimeline([
      item("a", "2026-03-01T00:00:00.000Z", "2026-03-11T00:00:00.000Z"),
      item("b", "2026-03-06T00:00:00.000Z", "2026-03-21T00:00:00.000Z"),
    ]);

    // Range is 1–21 March: 20 days. `a` starts at 0% and runs half of it.
    expect(spanBounds(layout.spans[0]!, layout)).toEqual({ left: 0, width: 50 });
    expect(spanBounds(layout.spans[1]!, layout)).toEqual({ left: 25, width: 75 });
  });

  it("does not divide by zero when every span sits at the same instant", () => {
    const layout = layoutTimeline([
      item("a", "2026-03-01T00:00:00.000Z", null),
      item("b", "2026-03-01T00:00:00.000Z", null),
    ]);

    expect(layout.maxMs).toBe(layout.minMs);
    for (const span of layout.spans) {
      const bounds = spanBounds(span, layout);
      expect(Number.isFinite(bounds.left)).toBe(true);
      expect(Number.isFinite(bounds.width)).toBe(true);
      expect(bounds).toEqual({ left: 0, width: 0 });
    }
  });
});
