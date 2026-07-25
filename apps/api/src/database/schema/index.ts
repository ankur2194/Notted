// Part 12: schema barrel. Identity tables are added in Part 13; remaining
// application tables are added in Parts 14–18. Each later part appends its
// exported tables and relations to the aggregate `schema` object so the Drizzle
// adapter and the typed `db` handle remain a single source of truth.

export const schema = {
  // Intentionally empty in Part 12. Tables and relations are added in Part 13.
} as const;

/**
 * Aggregate schema type consumed by the Drizzle handle and transaction types.
 * Re-exported so callers depend on the barrel rather than the `typeof` query.
 */
export type Schema = typeof schema;
