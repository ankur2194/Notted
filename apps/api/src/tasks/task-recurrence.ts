// Part 47: recurrence arithmetic. Deliberately a plain module, not a Nest
// provider — it has no dependencies, so it stays unit-testable without a
// module fixture and callable from inside a transaction.
//
// TIMEZONE MODEL (the whole rule set in one place, because Part 48 inherits it):
// - Storage is canonical UTC in `tasks.due_date timestamptz`. There is no
//   separate date column and no separate time column.
// - The CLIENT owns date <-> instant conversion: it composes the user's local
//   date plus optional time into one full ISO instant and renders it back in
//   the viewer's zone. The server never guesses a zone.
// - Recurrence advances by UTC interval arithmetic, with monthly clamped to the
//   target month's last day.
// - `custom` cron fields are UTC fields (`{ tz: "UTC" }`), so `0 9 * * 1` means
//   09:00 UTC Monday, not 09:00 somewhere.
// - "Overdue" is NOT a server field. It is `dueDate < now` evaluated in the
//   viewer's zone, so a task is not overdue for a client whose day has not
//   ended yet.
//
// ponytail: pure UTC intervals mean a "daily 09:00 local" task drifts by one
// hour across a DST boundary in an observing zone (it stays 09:00 UTC, so it
// lands at 10:00 local in summer). Upgrade path is a `tasks.time_zone` column
// plus zone-aware advancement here; not worth a migration until a user
// actually reports the drift.
//
// ponytail: `monthly` keeps its anchor day within ONE call, but the spawned row
// stores the clamped date, so a Jan 31 task completed month after month walks
// 31 -> Feb 28 -> Mar 28 across successive spawns. Holding the true anchor needs
// a column (`tasks.recurrence_anchor_day`), which Part 47 is not permitted to
// add. Upgrade path is that column, read here in place of `from.getUTCDate()`.

import { HttpStatus } from "@nestjs/common";
import { parseExpression } from "cron-parser";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { TASK_RECURRENCE_HORIZON_YEARS } from "./tasks.constants";

import type { TaskRecurrence } from "@notted/shared-types";

const DAY_MS = 24 * 60 * 60 * 1_000;

function invalidCron(): never {
  throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
    code: "TASK_RECURRENCE_INVALID",
    message: "The recurrence schedule is not a valid cron expression.",
  });
}

/**
 * Validates the cron grammar with the same parser that later evaluates it, so
 * an expression that passes here cannot fail at completion time. A regex would
 * only ever be a worse second opinion on ranges, steps and name aliases.
 */
export function assertCron(expression: string): void {
  try {
    parseExpression(expression, { tz: "UTC" });
  } catch {
    invalidCron();
  }
}

/**
 * `from` advanced by `months`, keeping its day-of-month and clamping into the
 * target month when that day does not exist there.
 *
 * `Date.UTC(y, m, 0)` is day zero of month `m`, i.e. the last day of month
 * `m - 1`, and it carries year rollover and leap years for free.
 *
 * Clamping always measures from the ORIGINAL date, never from the previously
 * clamped one. Stepping Jan 31 by 1 then by 1 again would yield Feb 28 then
 * Mar 28 and quietly lose the anchor day; stepping by 1 then by 2 yields
 * Feb 28 then Mar 31, which is what "monthly on the 31st" means.
 */
function addMonthsClamped(from: Date, months: number): Date {
  const lastDay = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months + 1, 0),
  ).getUTCDate();
  const next = new Date(from.getTime());
  next.setUTCFullYear(
    from.getUTCFullYear(),
    from.getUTCMonth() + months,
    Math.min(from.getUTCDate(), lastDay),
  );
  return next;
}

/** Smallest `from + k * interval` (k >= 1) that is strictly after `floor`. */
function advanceFixed(from: Date, intervalMs: number, floor: number): Date {
  const steps = Math.max(1, Math.floor((floor - from.getTime()) / intervalMs) + 1);
  return new Date(from.getTime() + steps * intervalMs);
}

/**
 * The next occurrence strictly after both `from` and `now`, or `null` when the
 * recipe does not recur or the next match falls beyond the horizon.
 *
 * Advancing past `now` is the catch-up rule: completing a daily task that has
 * been due since January must not spawn a successor that is already overdue,
 * which would force the user to tick the same task a few hundred times to get
 * back to the present. The horizon is still measured from `from`, so an
 * abandoned recurrence far in the past simply stops instead of being replayed.
 *
 * The named recipes are NOT routed through cron on purpose: no cron expression
 * can say "the same day-of-month next month" for the 31st. `0 0 31 * *` simply
 * skips February, which silently drops a recurrence the user asked for.
 */
export function nextOccurrence(
  recurrence: TaskRecurrence,
  cron: string | null,
  from: Date,
  now: Date = new Date(),
): Date | null {
  if (recurrence === "none") return null;
  const horizon = new Date(from.getTime());
  horizon.setUTCFullYear(from.getUTCFullYear() + TASK_RECURRENCE_HORIZON_YEARS);
  const floor = Math.max(from.getTime(), now.getTime());
  const candidate = advance(recurrence, cron, from, floor);
  if (candidate === null || !Number.isFinite(candidate.getTime())) return null;
  return candidate.getTime() > horizon.getTime() ? null : candidate;
}

function advance(
  recurrence: TaskRecurrence,
  cron: string | null,
  from: Date,
  floor: number,
): Date | null {
  switch (recurrence) {
    case "none":
      return null;
    case "daily":
      return advanceFixed(from, DAY_MS, floor);
    case "weekly":
      return advanceFixed(from, 7 * DAY_MS, floor);
    case "monthly": {
      // Bounded by the horizon: at most twelve steps per year, plus one so the
      // final month inside the horizon is still reachable.
      for (let months = 1; months <= 12 * TASK_RECURRENCE_HORIZON_YEARS + 1; months += 1) {
        const at = addMonthsClamped(from, months);
        if (at.getTime() > floor) return at;
      }
      return null;
    }
    case "custom": {
      if (cron === null) return null;
      try {
        return parseExpression(cron, { tz: "UTC", currentDate: new Date(floor) })
          .next()
          .toDate();
      } catch {
        return invalidCron();
      }
    }
  }
}
