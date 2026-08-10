import { describe, expect, it } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { assertCron, nextOccurrence } from "./task-recurrence";

const at = (value: string): Date => new Date(value);
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * `now` defaults to the due date itself so a case that is only about interval
 * arithmetic is not silently turned into a catch-up case by the real clock.
 * Catch-up has its own describe block below.
 */
const next = (
  recurrence: Parameters<typeof nextOccurrence>[0],
  cron: string | null,
  from: Date,
  now: Date = from,
): Date | null => nextOccurrence(recurrence, cron, from, now);

describe("nextOccurrence named recipes", () => {
  it.each([
    ["none", "2026-03-01T09:00:00.000Z", null],
    ["daily", "2026-03-01T09:00:00.000Z", "2026-03-02T09:00:00.000Z"],
    // Crossing a month end, and a leap day, purely as UTC intervals.
    ["daily", "2028-02-28T23:30:00.000Z", "2028-02-29T23:30:00.000Z"],
    ["weekly", "2026-03-01T09:00:00.000Z", "2026-03-08T09:00:00.000Z"],
    ["weekly", "2026-12-28T09:00:00.000Z", "2027-01-04T09:00:00.000Z"],
    ["monthly", "2026-03-15T09:00:00.000Z", "2026-04-15T09:00:00.000Z"],
  ] as const)("advances %s from %s", (recurrence, from, expected) => {
    expect(iso(next(recurrence, null, at(from)))).toBe(expected);
  });

  it.each([
    // The whole reason monthly is not routed through cron: `0 0 31 * *` would
    // skip February outright instead of clamping into it.
    ["non-leap February", "2027-01-31T09:00:00.000Z", "2027-02-28T09:00:00.000Z"],
    ["leap February", "2028-01-31T09:00:00.000Z", "2028-02-29T09:00:00.000Z"],
    ["31-day into 30-day", "2026-05-31T09:00:00.000Z", "2026-06-30T09:00:00.000Z"],
    ["year rollover", "2026-12-31T09:00:00.000Z", "2027-01-31T09:00:00.000Z"],
    ["short month keeps its day", "2028-02-29T09:00:00.000Z", "2028-03-29T09:00:00.000Z"],
  ])("clamps monthly to the target month's last day: %s", (_name, from, expected) => {
    expect(iso(next("monthly", null, at(from)))).toBe(expected);
  });

  it("keeps the time of day when clamping the date", () => {
    const spawned = next("monthly", null, at("2027-01-31T13:45:07.250Z"));
    expect(iso(spawned)).toBe("2027-02-28T13:45:07.250Z");
  });
});

describe("nextOccurrence catch-up past the completion instant", () => {
  it("skips a backlog instead of spawning an already-overdue successor", () => {
    // Due since March, ticked in August: the successor must land in the future,
    // not on 2026-03-02, which would demand ~160 more completions to catch up.
    expect(
      iso(next("daily", null, at("2026-03-01T09:00:00.000Z"), at("2026-08-09T12:00:00.000Z"))),
    ).toBe("2026-08-10T09:00:00.000Z");
    expect(
      iso(next("weekly", null, at("2026-03-01T09:00:00.000Z"), at("2026-08-09T12:00:00.000Z"))),
    ).toBe("2026-08-16T09:00:00.000Z");
    // The phase of the original due date survives: every candidate is
    // `from + k * interval`, so a weekly task stays on its weekday.
    expect(
      new Date(
        iso(next("weekly", null, at("2026-03-01T09:00:00.000Z"), at("2026-08-09T12:00:00.000Z")))!,
      ).getUTCDay(),
    ).toBe(at("2026-03-01T09:00:00.000Z").getUTCDay());
  });

  it("advances a monthly backlog from the original anchor day, not the clamped one", () => {
    // Stepping one month at a time from each clamped result would walk
    // 31 -> Feb 28 -> Mar 28; measuring every step from January keeps the 31st.
    expect(
      iso(next("monthly", null, at("2027-01-31T09:00:00.000Z"), at("2027-03-10T00:00:00.000Z"))),
    ).toBe("2027-03-31T09:00:00.000Z");
  });

  it("still advances exactly one step when the task is completed on time", () => {
    expect(
      iso(next("daily", null, at("2026-03-01T09:00:00.000Z"), at("2026-03-01T09:05:00.000Z"))),
    ).toBe("2026-03-02T09:00:00.000Z");
  });

  it("stops rather than replaying a recurrence abandoned beyond the horizon", () => {
    expect(
      next("daily", null, at("2016-03-01T09:00:00.000Z"), at("2026-08-09T12:00:00.000Z")),
    ).toBeNull();
  });
});

describe("nextOccurrence custom cron", () => {
  it("delegates to cron-parser with UTC fields and the completion instant", () => {
    expect(iso(next("custom", "0 9 * * *", at("2026-03-01T10:00:00.000Z")))).toBe(
      "2026-03-02T09:00:00.000Z",
    );
    expect(iso(next("custom", "*/15 * * * *", at("2026-03-01T10:07:00.000Z")))).toBe(
      "2026-03-01T10:15:00.000Z",
    );
  });

  it("returns null for a custom recurrence with no expression", () => {
    expect(next("custom", null, at("2026-03-01T09:00:00.000Z"))).toBeNull();
  });

  it("returns null past the five-year horizon instead of scheduling a ghost", () => {
    // The next 29 February after 2096 is 2104 — 2100 is not a leap year — so the
    // match is real but eight years out.
    expect(next("custom", "0 0 29 2 *", at("2096-03-01T00:00:00.000Z"))).toBeNull();
    // The same expression inside the horizon still resolves.
    expect(iso(next("custom", "0 0 29 2 *", at("2026-03-01T00:00:00.000Z")))).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });
});

describe("cron validation", () => {
  it.each(["0 9 * * *", "*/15 * * * *", "0 0 1 */2 *", "30 6 * * MON"])(
    "accepts %s",
    (expression) => {
      expect(() => assertCron(expression)).not.toThrow();
    },
  );

  it.each(["not a cron", "61 * * * *", "0 0 30 2 *", "* * * *  bogus"])(
    "rejects %s with a 422 the client can act on",
    (expression) => {
      try {
        assertCron(expression);
        throw new Error("expected the call to reject");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ApiHttpException);
        const api = error as ApiHttpException;
        expect(api.getStatus()).toBe(422);
        expect(api.safeResponse.code).toBe("TASK_RECURRENCE_INVALID");
      }
    },
  );

  it("rejects an invalid expression at evaluation time too, never silently skipping", () => {
    expect(() => next("custom", "not a cron", at("2026-03-01T00:00:00.000Z"))).toThrow(
      ApiHttpException,
    );
  });
});
