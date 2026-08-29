import { resolve } from "node:path";

import { isTable, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  account,
  accountRelations,
  BETTER_AUTH_SCHEMA_CONTRACT,
  passkey,
  passkeyRelations,
  schema,
  session,
  sessionRelations,
  twoFactor,
  twoFactorRelations,
  users,
  usersRelations,
  verification,
} from "../src/database/schema";

import { primaryKeyColumns, HAS_DATABASE, requireDatabase } from "./database-test-helpers";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

/** True when `value` looks like a Drizzle `Relations` object (config + table). */
function isRelationsObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { config?: unknown }).config === "function" &&
    typeof (value as { table?: unknown }).table === "object"
  );
}

// ----------------------------------------------------------------------------
// Unit tests: schema shape, columns, indexes, and relations. These run without
// a database because they only inspect Drizzle table metadata that was
// declared in TypeScript.
// ----------------------------------------------------------------------------

describe("identity and authentication schema (unit)", () => {
  it("exposes the application and Better Auth tables in the schema barrel", () => {
    // Application user profile (also Better Auth's `user` table).
    expect(isTable(schema.users)).toBe(true);
    // Better Auth-owned auth tables.
    expect(isTable(schema.session)).toBe(true);
    expect(isTable(schema.account)).toBe(true);
    expect(isTable(schema.verification)).toBe(true);
    expect(isTable(schema.twoFactor)).toBe(true);
    expect(isTable(schema.passkey)).toBe(true);

    // The barrel also exposes the relation objects so the Drizzle adapter can
    // use experimental joins.
    for (const rel of [
      schema.usersRelations,
      schema.sessionRelations,
      schema.accountRelations,
      schema.twoFactorRelations,
      schema.passkeyRelations,
    ]) {
      expect(isRelationsObject(rel)).toBe(true);
    }
  });

  it("exports each table and relation object by name", () => {
    expect(users).toBe(schema.users);
    expect(session).toBe(schema.session);
    expect(account).toBe(schema.account);
    expect(verification).toBe(schema.verification);
    expect(twoFactor).toBe(schema.twoFactor);
    expect(passkey).toBe(schema.passkey);

    expect(usersRelations).toBe(schema.usersRelations);
    expect(sessionRelations).toBe(schema.sessionRelations);
    expect(accountRelations).toBe(schema.accountRelations);
    expect(twoFactorRelations).toBe(schema.twoFactorRelations);
    expect(passkeyRelations).toBe(schema.passkeyRelations);
  });

  it("declares the users table with the application profile columns", () => {
    const config = getTableConfig(users);
    const cols = new Map(config.columns.map((c) => [c.name, c]));

    expect(primaryKeyColumns(users)).toContainEqual(["id"]);
    expect(cols.get("id")?.notNull).toBe(true);
    expect(cols.get("email")?.notNull).toBe(true);
    expect(cols.get("name")?.notNull).toBe(true);
    // Better Auth's `image` property maps to the existing avatar_url column.
    expect(cols.get("avatar_url")?.notNull).toBe(false);
    // Better Auth owns the boolean; Notted retains the verification timestamp.
    expect(cols.get("email_verified")?.notNull).toBe(true);
    expect(cols.get("email_verified_at")?.notNull).toBe(false);
    // twoFactorEnabled is the Better Auth twoFactor plugin's user column.
    expect(cols.get("two_factor_enabled")?.notNull).toBe(true);
    expect(cols.get("created_at")?.notNull).toBe(true);
    expect(cols.get("updated_at")?.notNull).toBe(true);
    expect(users.image.name).toBe("avatar_url");
    expect("avatarUrl" in users).toBe(false);
    expect(users.emailVerified.name).toBe("email_verified");
    expect(users.emailVerifiedAt.name).toBe("email_verified_at");
  });

  it("reserves database-generated user IDs and the existing users model for Part 21", () => {
    expect(BETTER_AUTH_SCHEMA_CONTRACT).toEqual({
      advanced: { database: { generateId: false } },
      user: { modelName: "users" },
    });
  });

  it("declares the Better Auth account table with the adapter's expected fields", () => {
    const config = getTableConfig(account);
    const cols = new Map(config.columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "account_id",
      "provider_id",
      "user_id",
      "access_token",
      "refresh_token",
      "id_token",
      "access_token_expires_at",
      "refresh_token_expires_at",
      "scope",
      "password",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `account.${name}`).toBe(true);
    }
    expect(cols.get("account_id")?.notNull).toBe(true);
    expect(cols.get("provider_id")?.notNull).toBe(true);
    expect(cols.get("user_id")?.notNull).toBe(true);
    // OAuth secrets stay nullable in the schema.
    expect(cols.get("access_token")?.notNull).toBe(false);
    expect(cols.get("password")?.notNull).toBe(false);
  });

  it("declares the Better Auth session table with token, expiry, and user FK", () => {
    const config = getTableConfig(session);
    const cols = new Map(config.columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "expires_at",
      "token",
      "created_at",
      "updated_at",
      "ip_address",
      "user_agent",
      "user_id",
    ]) {
      expect(cols.has(name), `session.${name}`).toBe(true);
    }
    expect(cols.get("token")?.notNull).toBe(true);
    expect(cols.get("expires_at")?.notNull).toBe(true);
    expect(cols.get("user_id")?.notNull).toBe(true);
    expect(cols.get("ip_address")?.notNull).toBe(false);
  });

  it("declares the Better Auth verification table with no user FK", () => {
    const config = getTableConfig(verification);
    const cols = new Map(config.columns.map((c) => [c.name, c]));
    for (const name of ["id", "identifier", "value", "expires_at", "created_at", "updated_at"]) {
      expect(cols.has(name), `verification.${name}`).toBe(true);
    }
    // The core verification schema has no user FK (magic link / email OTP reuse it).
    expect(config.foreignKeys).toHaveLength(0);
  });

  it("declares the Better Auth twoFactor table with secret, backup codes, and lockout", () => {
    const config = getTableConfig(twoFactor);
    const cols = new Map(config.columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "secret",
      "backup_codes",
      "user_id",
      "verified",
      "failed_verification_count",
      "locked_until",
    ]) {
      expect(cols.has(name), `two_factor.${name}`).toBe(true);
    }
    expect(cols.get("secret")?.notNull).toBe(true);
    expect(cols.get("backup_codes")?.notNull).toBe(true);
    expect(cols.get("verified")?.notNull).toBe(true);
    expect(cols.get("failed_verification_count")?.notNull).toBe(true);
    expect(cols.get("locked_until")?.notNull).toBe(false);
  });

  it("declares the Better Auth passkey table with WebAuthn credential fields", () => {
    const config = getTableConfig(passkey);
    const cols = new Map(config.columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "name",
      "public_key",
      "user_id",
      "credential_id",
      "counter",
      "device_type",
      "backed_up",
      "transports",
      "created_at",
      "aaguid",
    ]) {
      expect(cols.has(name), `passkey.${name}`).toBe(true);
    }
    expect(cols.get("public_key")?.notNull).toBe(true);
    expect(cols.get("credential_id")?.notNull).toBe(true);
    expect(cols.get("counter")?.notNull).toBe(true);
    expect(cols.get("backed_up")?.notNull).toBe(true);
    expect(cols.get("name")?.notNull).toBe(false);
  });

  it("cascades user deletion to account, session, twoFactor, and passkey", () => {
    function userFk(table: typeof account | typeof session | typeof twoFactor | typeof passkey) {
      return getTableConfig(table).foreignKeys.find((key) => key.getName().includes("user_id"));
    }

    const accountFk = userFk(account);
    expect(accountFk, "account should have a user_id foreign key").toBeDefined();
    expect(accountFk?.onDelete).toBe("cascade");

    const sessionFk = userFk(session);
    expect(sessionFk, "session should have a user_id foreign key").toBeDefined();
    expect(sessionFk?.onDelete).toBe("cascade");

    const twoFactorFk = userFk(twoFactor);
    expect(twoFactorFk, "two_factor should have a user_id foreign key").toBeDefined();
    expect(twoFactorFk?.onDelete).toBe("cascade");

    const passkeyFk = userFk(passkey);
    expect(passkeyFk, "passkey should have a user_id foreign key").toBeDefined();
    expect(passkeyFk?.onDelete).toBe("cascade");
  });

  it("declares the expected useful indexes", () => {
    const indexes = (table: PgTable) =>
      new Map(
        getTableConfig(table).indexes.map((idx) => [idx.config.name ?? "", idx.config.unique]),
      );

    // Functional unique index for case-insensitive email uniqueness.
    expect(indexes(users).get("users_email_lower_unique")).toBe(true);
    // Session token lookup.
    expect(indexes(session).get("session_token_unique")).toBe(true);
    // OAuth provider account uniqueness.
    expect(indexes(account).get("account_provider_account_id_unique")).toBe(true);
    // WebAuthn credential ID uniqueness.
    expect(indexes(passkey).get("passkey_credential_id_unique")).toBe(true);
    // Non-unique lookup indexes (userId back-pointers and verification lookup).
    expect(indexes(account).get("account_user_id_idx")).toBe(false);
    expect(indexes(session).get("session_user_id_idx")).toBe(false);
    expect(indexes(twoFactor).get("two_factor_user_id_idx")).toBe(false);
    expect(indexes(twoFactor).get("two_factor_secret_idx")).toBe(false);
    expect(indexes(passkey).get("passkey_user_id_idx")).toBe(false);
    expect(indexes(verification).get("verification_identifier_idx")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Live migration test (DATABASE_URL-gated). Follows the same skip pattern as
// `database.migration.test.ts` so it is inert in CI without a database and
// skips cleanly when the dev compose stack is not running.
// ----------------------------------------------------------------------------

describe.skipIf(!HAS_DATABASE)("identity schema (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase | undefined;

  beforeAll(async () => {
    await requireDatabase();
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end().catch(() => {
        /* pool shutdown is best-effort during teardown */
      });
    }
  });

  it("applies the identity migration and creates the Better Auth tables", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const tables = (
      await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('users', 'session', 'account', 'verification', 'two_factor', 'passkey')
        order by table_name
      `)
    ).rows as unknown as ReadonlyArray<{ table_name: string }>;

    expect(tables.map((row) => row.table_name)).toEqual([
      "account",
      "passkey",
      "session",
      "two_factor",
      "users",
      "verification",
    ]);
  });

  it("declares key columns with the types Better Auth and Notted expect", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const columns = (
      await db.execute(sql`
        select table_name, column_name, data_type, udt_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name in ('users', 'session', 'account', 'verification', 'two_factor', 'passkey')
        order by table_name, column_name
      `)
    ).rows as unknown as ReadonlyArray<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>;

    const byKey = new Map(columns.map((c) => [`${c.table_name}.${c.column_name}`, c]));

    // Better Auth's email_verified is a non-null boolean.
    const emailVerified = byKey.get("users.email_verified");
    expect(emailVerified?.data_type).toBe("boolean");
    expect(emailVerified?.is_nullable).toBe("NO");
    expect(emailVerified?.column_default).toBe("false");

    // Notted's independent verification timestamp remains nullable.
    const emailVerifiedAt = byKey.get("users.email_verified_at");
    expect(emailVerifiedAt?.data_type).toBe("timestamp with time zone");
    expect(emailVerifiedAt?.is_nullable).toBe("YES");

    // users.two_factor_enabled is a non-null boolean defaulting to false.
    const twoFactorEnabled = byKey.get("users.two_factor_enabled");
    expect(twoFactorEnabled?.data_type).toBe("boolean");
    expect(twoFactorEnabled?.is_nullable).toBe("NO");

    // account.user_id is a non-null uuid.
    const accountUserId = byKey.get("account.user_id");
    expect(accountUserId?.data_type).toBe("uuid");
    expect(accountUserId?.is_nullable).toBe("NO");

    // session.token is a non-null character varying.
    const sessionToken = byKey.get("session.token");
    expect(sessionToken?.data_type).toBe("character varying");
    expect(sessionToken?.is_nullable).toBe("NO");

    // two_factor.failed_verification_count is a non-null integer.
    const failedCount = byKey.get("two_factor.failed_verification_count");
    expect(failedCount?.data_type).toBe("integer");
    expect(failedCount?.is_nullable).toBe("NO");

    // passkey.backed_up is a non-null boolean (the v1.6 docs field name).
    const backedUp = byKey.get("passkey.backed_up");
    expect(backedUp?.data_type).toBe("boolean");
    expect(backedUp?.is_nullable).toBe("NO");

    // passkey.credential_id is a non-null text column.
    const credentialId = byKey.get("passkey.credential_id");
    expect(credentialId?.data_type).toBe("text");
    expect(credentialId?.is_nullable).toBe("NO");
  });

  it("creates the unique and lookup indexes the schema requires", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const indexes = (
      await db.execute(sql`
        select indexname, tablename
        from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'users_email_lower_unique',
            'session_token_unique',
            'account_provider_account_id_unique',
            'account_user_id_idx',
            'session_user_id_idx',
            'two_factor_user_id_idx',
            'two_factor_secret_idx',
            'verification_identifier_idx',
            'passkey_user_id_idx',
            'passkey_credential_id_unique'
          )
        order by indexname
      `)
    ).rows as unknown as ReadonlyArray<{ indexname: string; tablename: string }>;

    const names = new Set(indexes.map((row) => row.indexname));
    for (const expected of [
      "users_email_lower_unique",
      "session_token_unique",
      "account_provider_account_id_unique",
      "account_user_id_idx",
      "session_user_id_idx",
      "two_factor_user_id_idx",
      "two_factor_secret_idx",
      "verification_identifier_idx",
      "passkey_user_id_idx",
      "passkey_credential_id_unique",
    ]) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });

  it("cascades user deletion across the auth tables", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const fks = (
      await db.execute(sql`
        select tc.table_name, rc.delete_rule
        from information_schema.referential_constraints rc
        join information_schema.table_constraints tc
          on rc.constraint_name = tc.constraint_name
        where tc.table_schema = 'public'
          and tc.table_name in ('account', 'session', 'two_factor', 'passkey')
        order by tc.table_name
      `)
    ).rows as unknown as ReadonlyArray<{ table_name: string; delete_rule: string }>;

    expect(fks.length).toBeGreaterThanOrEqual(4);
    for (const fk of fks) {
      expect(fk.delete_rule).toBe("CASCADE");
    }
  });
});
