import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Part 50 platform authority migration", () => {
  it("adds a deny-by-default user boolean and narrow platform audit table", () => {
    const migration = readFileSync(
      resolve(__dirname, "../src/database/migrations/0016_high_jigsaw.sql"),
      "utf8",
    );
    expect(migration).toContain('ADD COLUMN "is_platform_operator" boolean DEFAULT false NOT NULL');
    expect(migration).toContain('CREATE TABLE "platform_admin_audits"');
    expect(migration).toContain('"operator_user_id" uuid NOT NULL');
    expect(migration).toContain('"action" varchar(40) NOT NULL');
    expect(migration).toContain('"queue_name" varchar(64) NOT NULL');
    expect(migration).toContain('"job_id" varchar(128)');
    expect(migration).toContain('"request_id" uuid NOT NULL');
    expect(migration).not.toMatch(/payload|cookie|user_agent|ip_address|query|body/iu);
  });
});

describe("Part 50 reconciliation and audit-outcome migration", () => {
  it("adds forward-only processing boundaries and safe audit defaults", () => {
    const migration = readFileSync(
      resolve(__dirname, "../src/database/migrations/0017_sloppy_giant_man.sql"),
      "utf8",
    );
    expect(migration).toContain("reconciliation_required");
    expect(migration).toContain("processing_started_at");
    expect(migration).toContain("DEFAULT 'attempt' NOT NULL");
    expect(migration).toContain("DEFAULT 'authorized' NOT NULL");
  });
});
