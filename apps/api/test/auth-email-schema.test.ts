import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  authEmailIntents,
  authEmailIntentStatusEnum,
  authEmailPurposeEnum,
} from "../src/database/schema";

describe("encrypted authentication email intent schema", () => {
  it("has explicit authenticated-encryption and one-time lifecycle columns", () => {
    const config = getTableConfig(authEmailIntents);
    const names = new Set(config.columns.map((column) => column.name));
    for (const name of [
      "encrypted_context",
      "encryption_key_version",
      "nonce",
      "authentication_tag",
      "expires_at",
      "consumed_at",
      "terminal_at",
      "status",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    expect([...names].some((name) => /token|url|body|password|cookie|session/iu.test(name))).toBe(
      false,
    );
  });

  it("defines bounded purpose and terminal-state vocabularies", () => {
    expect(authEmailPurposeEnum.enumValues).toEqual([
      "registration_verification",
      "verification_resend",
      "magic_link",
      "password_reset_request",
      "password_reset_confirmation",
    ]);
    expect(authEmailIntentStatusEnum.enumValues).toContain("expired");
    expect(authEmailIntentStatusEnum.enumValues).toContain("sent");
  });
});
