import { isTable } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema, workspaceDeletionAudits } from "../src/database/schema";

describe("workspace deletion audit schema", () => {
  it("exports an identifier-only tombstone with no destructive foreign keys", () => {
    expect(isTable(schema.workspaceDeletionAudits)).toBe(true);
    expect(workspaceDeletionAudits).toBe(schema.workspaceDeletionAudits);

    const config = getTableConfig(workspaceDeletionAudits);
    const columns = new Map(config.columns.map((column) => [column.name, column]));
    expect([...columns.keys()].sort()).toEqual([
      "actor_id",
      "created_at",
      "deleted_workspace_id",
      "id",
      "request_id",
    ]);
    expect(columns.get("deleted_workspace_id")?.notNull).toBe(true);
    expect(columns.get("actor_id")?.notNull).toBe(false);
    expect(columns.get("request_id")?.notNull).toBe(false);
    expect(config.foreignKeys).toHaveLength(0);
  });
});
