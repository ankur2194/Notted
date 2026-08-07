import { sql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { notes } from "./schema";
import { maxTimestamp } from "./sql-aggregates";

// The exact wire shape `drizzle-orm`'s node-postgres session yields for a
// TIMESTAMPTZ column: its `getTypeParser` override returns the raw string
// untouched so each column decoder can map it back to a `Date`.
const RAW_TIMESTAMPTZ = "2026-08-07 06:50:16.563+00";
const RAW_TIMESTAMPTZ_EPOCH_MS = Date.parse("2026-08-07T06:50:16.563Z");

/**
 * `SQL#decoder` is the field `mapResultRow` reads to turn a driver value into
 * the JS value a caller sees. Drizzle does not declare it publicly, so this one
 * narrow cast keeps the assertion honest without spreading `any` through the
 * test. The behavior it stands for is also covered end to end against real
 * PostgreSQL in `test/projects.integration.test.ts`.
 */
function decode(expression: SQL<unknown>, driverValue: string): unknown {
  const { decoder } = expression as unknown as {
    readonly decoder: { readonly mapFromDriverValue: (value: unknown) => unknown };
  };
  return decoder.mapFromDriverValue(driverValue);
}

describe("maxTimestamp", () => {
  it("attaches the column decoder so the raw driver string becomes a Date", () => {
    const decoded = decode(maxTimestamp(notes.updatedAt), RAW_TIMESTAMPTZ);

    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).getTime()).toBe(RAW_TIMESTAMPTZ_EPOCH_MS);
  });

  it("decodes identically to a plain column selection", () => {
    expect(decode(maxTimestamp(notes.updatedAt), RAW_TIMESTAMPTZ)).toEqual(
      notes.updatedAt.mapFromDriverValue(RAW_TIMESTAMPTZ),
    );
  });

  it("differs from a bare sql expression, which leaves the value a string", () => {
    // Guards the regression directly: a bare `sql<Date>` aggregate keeps
    // drizzle's no-op decoder, so the value never becomes a `Date` and any
    // later `.getTime()` call throws.
    const bare = sql<Date | null>`max(${notes.updatedAt})`;

    expect(decode(bare, RAW_TIMESTAMPTZ)).toBe(RAW_TIMESTAMPTZ);
    expect(decode(bare, RAW_TIMESTAMPTZ)).not.toBeInstanceOf(Date);
  });

  it("renders a max() aggregate over the column", () => {
    const chunks = maxTimestamp(notes.updatedAt).queryChunks;

    // Chunks 0 and 2 are drizzle `StringChunk` literals wrapping `max(` and
    // `)`; chunk 1 is the column itself, which is what makes the decoder right.
    expect(
      chunks
        .map((chunk) => (chunk as { value?: readonly string[] }).value)
        .filter((value): value is readonly string[] => Array.isArray(value))
        .flat()
        .join(""),
    ).toBe("max()");
    expect(chunks).toContain(notes.updatedAt);
  });
});
