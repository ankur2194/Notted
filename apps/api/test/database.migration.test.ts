import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";

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
