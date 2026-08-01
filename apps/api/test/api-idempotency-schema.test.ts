import { isTable } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { apiIdempotencyRecords, schema } from "../src/database/schema";

describe("API idempotency schema", () => {
  it("stores hashes and an opaque result identifier without raw requests", () => {
    expect(isTable(schema.apiIdempotencyRecords)).toBe(true);
    const config = getTableConfig(apiIdempotencyRecords);
    const names = config.columns.map((column) => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "actor_user_id",
        "operation",
        "key_hash",
        "payload_hash",
        "resource_id",
        "expires_at",
      ]),
    );
    expect(names).not.toEqual(expect.arrayContaining(["key", "payload", "result"]));
    expect(config.indexes.some((index) => index.config.unique)).toBe(true);
  });
});
