import { sql, type Column, type ColumnBaseConfig, type SQL } from "drizzle-orm";

/**
 * A column whose driver decoder produces a `Date` (`timestamp`, `timestamptz`,
 * and `date` columns in `date` mode). Narrowing the helper below to this type
 * keeps `maxTimestamp(notes.title)` a compile error.
 */
type DateColumn = Column<ColumnBaseConfig<"date", string>>;

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
