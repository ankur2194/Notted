// Part 13: Better Auth-owned identity and authentication tables.
//
// Field names and types match the schema the pinned Better Auth `1.6.24`
// adapter and its core/plugins declare, so ADR 0003's "sole owner" rule is
// honored and Part 21 can mount the Drizzle adapter without renaming:
//
//   - core (`@better-auth/core` `getAuthTables`): `user`, `session`, `account`,
//     `verification`. The `user` table is the application `users` table in
//     `users.ts`; the other three live here.
//   - `twoFactor` plugin (`better-auth/plugins/two-factor`): the `twoFactor`
//     table (TOTP secret, backup codes, lockout) plus the `twoFactorEnabled`
//     boolean on `users`. The plugin does not specify `onDelete` for the
//     `userId` reference; we choose `cascade` so deleting a user purges their
//     2FA state, matching the core account/session cascade behavior.
//   - `passkey` plugin (`@better-auth/passkey`, v1.6 docs): the `passkey`
//     WebAuthn credential table.
//
// Drizzle property keys are the camelCase names the adapter's `getFieldName`
// resolves to (`userId`, `emailVerified`, `twoFactorEnabled`, `credentialID`,
// `backedUp`, ...). Database column names follow Notted's snake_case
// convention. Password, access/refresh/id token, and 2FA secret/backup-code
// columns are `returned: false` in Better Auth; they are still persisted here
// and must never be selected into API responses or logs (enforced in Part 21).
//
// `magicLink` and `emailOtp` plugins do not add their own tables in 1.6.24;
// they reuse the core `verification` table, so no extra tables are added for
// them.

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

// --------------------------------------------------------------------------- //
// Better Auth core: account
// --------------------------------------------------------------------------- //

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Provider-side account id; equals `userId` for credential accounts.
    accountId: varchar("account_id", { length: 255 }).notNull(),
    // Provider id, e.g. "credential", "google", "github".
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // OAuth/credential secrets. Never selected into API responses or logs.
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    // Credential-account password hash. Managed by Better Auth; never logged.
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Lookup by user (matches Better Auth's `userId` index).
    index("account_user_id_idx").on(t.userId),
    // A given provider account can be linked to at most one Notted user.
    uniqueIndex("account_provider_account_id_unique").on(t.providerId, t.accountId),
  ],
);

// --------------------------------------------------------------------------- //
// Better Auth core: session
// --------------------------------------------------------------------------- //

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Session cookie token. Lookup path; kept unique at the DB layer.
    token: varchar("token", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: varchar("ip_address", { length: 255 }),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [
    uniqueIndex("session_token_unique").on(t.token),
    index("session_user_id_idx").on(t.userId),
  ],
);

// --------------------------------------------------------------------------- //
// Better Auth core: verification (magic link, email OTP, etc.)
// --------------------------------------------------------------------------- //

export const verification = pgTable(
  "verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Typically the email address being verified.
    identifier: varchar("identifier", { length: 255 }).notNull(),
    // The token/code being exchanged. Transient; never logged.
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// --------------------------------------------------------------------------- //
// Better Auth twoFactor plugin: two_factor
// --------------------------------------------------------------------------- //

export const twoFactor = pgTable(
  "two_factor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // TOTP shared secret. Stored encrypted by Better Auth; never logged.
    secret: text("secret").notNull(),
    // Encrypted backup codes; never logged or returned.
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    verified: boolean("verified").default(true).notNull(),
    failedVerificationCount: integer("failed_verification_count").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [
    index("two_factor_user_id_idx").on(t.userId),
    index("two_factor_secret_idx").on(t.secret),
  ],
);

// --------------------------------------------------------------------------- //
// Better Auth passkey plugin: passkey
// --------------------------------------------------------------------------- //

export const passkey = pgTable(
  "passkey",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }),
    // WebAuthn credential public key (SPKI). Never logged.
    publicKey: text("public_key").notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // WebAuthn credential ID (base64url). Lookup key during assertion.
    credentialID: text("credential_id").notNull(),
    // Authenticator signature counter.
    counter: integer("counter").notNull(),
    deviceType: varchar("device_type", { length: 255 }).notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Authenticator Attestation GUID; resolves to a friendly device label in UI.
    aaguid: varchar("aaguid", { length: 255 }),
  },
  (t) => [
    index("passkey_user_id_idx").on(t.userId),
    uniqueIndex("passkey_credential_id_unique").on(t.credentialID),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Plural field names on the `users` side match the Better Auth Drizzle
// adapter's join key when `usePlural` is false (default) and the relation is
// many-sided. `verification` has no user foreign key in the core schema, so it
// has no relation to `users`.

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(account),
  sessions: many(session),
  twoFactors: many(twoFactor),
  passkeys: many(passkey),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(users, { fields: [account.userId], references: [users.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(users, { fields: [session.userId], references: [users.id] }),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(users, { fields: [twoFactor.userId], references: [users.id] }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(users, { fields: [passkey.userId], references: [users.id] }),
}));
