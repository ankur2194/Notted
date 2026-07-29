// Part 13: application user profile and the Better Auth `user` table.
//
// ADR 0003 makes Better Auth the sole owner of identity, account, session,
// verification, two-factor, and passkey lifecycle. This `users` table is the
// single durable user record both Notted and Better Auth operate on. Part 21
// wires Better Auth to it via the explicit contract in `auth-contract.ts`; no
// parallel user or session table is introduced here.
//
// Conventions:
// - Drizzle property keys use the camelCase names Better Auth's adapter looks
//   up (`emailVerified`, `twoFactorEnabled`, ...). Database column names follow
//   Notted's snake_case convention.
// - Better Auth 1.6.24 owns the non-null boolean `emailVerified` field.
//   Notted's timestamp semantics are retained independently in the nullable
//   application field `emailVerifiedAt`.
// - Better Auth's `image` property maps directly to the existing `avatar_url`
//   database column, so Part 21 needs no field-name adapter for that property.
// - `twoFactorEnabled` is added here because the Better Auth `twoFactor` plugin
//   declares it on the user table; see `auth.ts` for the related `two_factor`
//   row table.
// - Email uniqueness is enforced case-insensitively via a functional unique
//   index on `lower(email)` so we do not depend on the `citext` extension (the
//   Part 12 extension migration only enables `uuid-ossp` and `vector`).
//
// Relations live in `auth.ts` to keep this module dependency-free for the
// later workspace/project/note tables that reference `users`.

import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    image: text("avatar_url"),
    emailVerified: boolean("email_verified").default(false).notNull(),
    // Application-tracked verification timestamp (see module note).
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    // Required by the Better Auth `twoFactor` plugin (see `auth.ts`).
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Case-insensitive uniqueness: two rows cannot share the same normalized
    // email even if their casing differs. A functional index keeps the column
    // type `varchar` and avoids a new PostgreSQL extension dependency.
    uniqueIndex("users_email_lower_unique").on(sql`lower(${t.email})`),
  ],
);
