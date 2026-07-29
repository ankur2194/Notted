import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;
const MIGRATION_0007 = resolve(MIGRATIONS_FOLDER, "0007_early_bloodaxe.sql");

const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";

describe("migration 0007 data safety (unit)", () => {
  it("copies verification timestamps before the explicit timestamp-to-boolean conversion", async () => {
    const migration = await readFile(MIGRATION_0007, "utf8");
    const addTimestamp = migration.indexOf(
      'ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone',
    );
    const copyTimestamp = migration.indexOf('SET "email_verified_at" = "email_verified"');
    const convertBoolean = migration.indexOf('USING ("email_verified" IS NOT NULL)');
    const setDefault = migration.indexOf(
      'ALTER TABLE "users" ALTER COLUMN "email_verified" SET DEFAULT false',
    );
    const setNotNull = migration.indexOf(
      'ALTER TABLE "users" ALTER COLUMN "email_verified" SET NOT NULL',
    );

    expect(addTimestamp).toBeGreaterThanOrEqual(0);
    expect(copyTimestamp).toBeGreaterThan(addTimestamp);
    expect(convertBoolean).toBeGreaterThan(copyTimestamp);
    expect(setDefault).toBeGreaterThan(convertBoolean);
    expect(setNotNull).toBeGreaterThan(setDefault);
  });

  it("creates the outbox contract and unique note-version key", async () => {
    const migration = await readFile(MIGRATION_0007, "utf8");
    const duplicatePreflight = migration.indexOf(
      "note_versions contains duplicate (note_id, version) rows",
    );
    const dropOldIndex = migration.indexOf('DROP INDEX "note_versions_note_version_idx"');
    expect(migration).toContain('CREATE TYPE "public"."job_outbox_status"');
    expect(migration).toContain('CREATE TABLE "job_outbox"');
    expect(migration).toContain('CREATE UNIQUE INDEX "job_outbox_idempotency_key_unique"');
    expect(migration).toContain('CREATE UNIQUE INDEX "note_versions_note_version_unique"');
    expect(duplicatePreflight).toBeGreaterThanOrEqual(0);
    expect(dropOldIndex).toBeGreaterThan(duplicatePreflight);
  });
});

async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {
      /* connection cleanup is best-effort during the reachability probe */
    });
  }
}

// The whole suite is skipped when DATABASE_URL is not exported (e.g. CI). When
// the variable is set, the suite still skips each test if PostgreSQL is not
// reachable, so a developer without dev compose running gets a clear skip.
describe.skipIf(!HAS_DATABASE_URL)("database migration (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase | undefined;
  let reachable = false;

  beforeAll(async () => {
    reachable = await isDatabaseReachable(DATABASE_URL as string);
    if (!reachable) {
      return;
    }
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

  it("applies migrations without losing pre-existing seeded data and runs a trivial query", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await db.execute(sql`
      create table if not exists "__notted_migration_seed_probe" (
        "id" integer primary key,
        "value" text not null
      )
    `);
    await db.execute(sql`
      insert into "__notted_migration_seed_probe" ("id", "value")
      values (1, 'preserved')
      on conflict ("id") do update set "value" = excluded."value"
    `);

    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const health = await db.execute(sql`select 1`);
      const seeded = await db.execute(
        sql`select "value" from "__notted_migration_seed_probe" where "id" = 1`,
      );
      expect(health.rows).toHaveLength(1);
      expect(seeded.rows).toEqual([{ value: "preserved" }]);
    } finally {
      await db.execute(sql`drop table if exists "__notted_migration_seed_probe"`);
    }
  });

  it("preserves old verification timestamps under migration 0007's PostgreSQL conversion", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.execute(sql`drop table if exists "__notted_email_verification_conversion_probe"`);
    await db.execute(sql`
      create temporary table "__notted_email_verification_conversion_probe" (
        "id" integer primary key,
        "email_verified" timestamp with time zone
      )
    `);

    try {
      await db.execute(sql`
        insert into "__notted_email_verification_conversion_probe" ("id", "email_verified")
        values
          (1, '2026-01-02T03:04:05.000Z'::timestamptz),
          (2, null)
      `);
      await db.execute(sql`
        alter table "__notted_email_verification_conversion_probe"
        add column "email_verified_at" timestamp with time zone
      `);
      await db.execute(sql`
        update "__notted_email_verification_conversion_probe"
        set "email_verified_at" = "email_verified"
        where "email_verified" is not null
      `);
      await db.execute(sql`
        alter table "__notted_email_verification_conversion_probe"
        alter column "email_verified" set data type boolean
        using ("email_verified" is not null)
      `);
      await db.execute(sql`
        alter table "__notted_email_verification_conversion_probe"
        alter column "email_verified" set default false
      `);
      await db.execute(sql`
        alter table "__notted_email_verification_conversion_probe"
        alter column "email_verified" set not null
      `);

      const converted = await db.execute(sql`
        select "id", "email_verified", "email_verified_at"
        from "__notted_email_verification_conversion_probe"
        order by "id"
      `);
      const rows = converted.rows as unknown as ReadonlyArray<{
        id: number;
        email_verified: boolean;
        email_verified_at: Date | string | null;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(1);
      expect(rows[0]?.email_verified).toBe(true);
      expect(new Date(rows[0]?.email_verified_at as Date | string).toISOString()).toBe(
        "2026-01-02T03:04:05.000Z",
      );
      expect(rows[1]).toEqual({ id: 2, email_verified: false, email_verified_at: null });
    } finally {
      await db.execute(sql`drop table if exists "__notted_email_verification_conversion_probe"`);
    }
  });

  it("has enabled the uuid-ossp and vector extensions", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const result = await db.execute(
      sql`select extname from pg_extension where extname in ('uuid-ossp', 'vector') order by extname`,
    );

    const names = (result.rows as unknown as ReadonlyArray<{ extname: string }>).map(
      (row) => row.extname,
    );
    expect(names).toEqual(["uuid-ossp", "vector"]);
  });
});
