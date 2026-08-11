import { sql, type Column, type ColumnBaseConfig, type SQL } from "drizzle-orm";

import { tasks } from "./schema";

/**
 * A column whose driver decoder produces a `Date` (`timestamp`, `timestamptz`,
 * and `date` columns in `date` mode). Narrowing the helper below to this type
 * keeps `maxTimestamp(notes.title)` a compile error.
 */
type DateColumn = Column<ColumnBaseConfig<"date", string>>;

/** Narrows `checklistSum` to integer columns, so summing a title will not compile. */
type IntegerColumn = Column<ColumnBaseConfig<"number", string>>;

/**
 * `max(column)` over a timestamp column, decoded to a real `Date`.
 *
 * `drizzle-orm`'s node-postgres session deliberately installs pg type parsers
 * that hand back `TIMESTAMPTZ` / `TIMESTAMP` / `DATE` / `INTERVAL` as **raw
 * strings** (`node-postgres/session.js`, `rawQueryConfig.types.getTypeParser`),
 * because it maps each value back to `Date` per column through that column's
 * own decoder. A bare ``sql`max(updated_at)` `` expression carries no decoder,
 * so its value stays a `string` at runtime no matter what type argument the
 * call site writes — `sql<Date>` on such an expression is a silent lie that
 * only surfaces when something later calls a `Date` method on the result.
 *
 * `mapWith(column)` attaches the column's decoder, restoring the same `Date`
 * the driver produces for a plain column selection. `mapResultRow` short
 * circuits `NULL` before the decoder runs, so an aggregate over zero rows still
 * yields `null` rather than a mangled epoch date — hence the `Date | null`
 * result type, which `mapWith`'s own `SQL<Date>` return type cannot express.
 *
 * Always prefer this helper over a hand-written `sql<Date>` aggregate.
 */
export function maxTimestamp(column: DateColumn): SQL<Date | null> {
  return sql`max(${column})`.mapWith(column) as SQL<Date | null>;
}

/**
 * The two halves of "task progress", defined ONCE.
 *
 * A note's progress bar and a project's rollup have to agree, and the only way
 * to guarantee that is for both to select the same expressions. `done` counts
 * the built-in `done` status — a task carrying a custom status keeps its
 * built-in one, so a board column named "Shipped" never silently redefines
 * completion. `canceled` tasks leave the denominator entirely: abandoned work
 * should not make a project look permanently unfinished.
 *
 * `cast(... as integer)` because PostgreSQL `count(*)` is `bigint`, which the
 * driver hands back as a string.
 */
export function taskDoneCount(): SQL<number> {
  return sql<number>`cast(count(*) filter (where ${tasks.status} = 'done') as integer)`;
}

export function taskOpenTotalCount(): SQL<number> {
  return sql<number>`cast(count(*) filter (where ${tasks.status} <> 'canceled') as integer)`;
}

/**
 * `sum()` over the denormalized inline-checklist counters, restricted to the
 * rows `filter` accepts. `0` for a project with no matching notes: `sum` of no
 * rows is NULL, and a NULL progress numerator is a rendering bug waiting to
 * happen.
 */
export function checklistSum(column: IntegerColumn, filter: SQL): SQL<number> {
  return sql<number>`cast(coalesce(sum(${column}) filter (where ${filter}), 0) as integer)`;
}
