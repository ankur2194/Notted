/**
 * Better Auth 1.6.24 schema contract reserved for Part 21 wiring.
 *
 * Notted already has a UUID primary key with a PostgreSQL default on `users`.
 * Better Auth must therefore preserve database-generated IDs instead of
 * generating adapter IDs, and it must mount the existing plural model.
 */
export const BETTER_AUTH_SCHEMA_CONTRACT = {
  advanced: {
    database: {
      generateId: false,
    },
  },
  user: {
    modelName: "users",
  },
} as const;
