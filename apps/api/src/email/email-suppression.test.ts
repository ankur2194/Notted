import { describe, expect, it, vi } from "vitest";

import {
  isSuppressed,
  normalizeRecipient,
  SUPPRESSIBLE_TEMPLATE_KEYS,
  UNSUBSCRIBE_RELATED_ENTITY_TYPE,
} from "./email-suppression";

import type { DatabaseTransaction } from "../database/database.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const USER_ID = "22222222-0000-4000-8000-000000000002";

interface FakeTx {
  readonly tx: DatabaseTransaction;
  readonly select: ReturnType<typeof vi.fn>;
}

/**
 * The fake cannot evaluate Drizzle SQL, so recipient matching is asserted at the
 * only layer this module controls: it normalises both sides before comparing.
 * The fake answers from a normalised sentinel set.
 */
function fakeTx(sentinels: readonly string[]): FakeTx {
  const stored = new Set(sentinels.map(normalizeRecipient));
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => (stored.size > 0 ? [{ id: USER_ID }] : []),
      }),
    }),
  }));
  return { tx: { select } as unknown as DatabaseTransaction, select };
}

describe("isSuppressed", () => {
  it("matches a stored lowercase sentinel against a mixed-case recipient", async () => {
    const fake = fakeTx(["a@b.com"]);
    await expect(isSuppressed(fake.tx, "A@B.COM", "mention", WORKSPACE_ID)).resolves.toBe(true);
    // Both sides are normalised, so historical mixed-case rows still match.
    expect(normalizeRecipient("  A@B.COM ")).toBe("a@b.com");
  });

  it("returns false when no sentinel row exists for the workspace", async () => {
    const fake = fakeTx([]);
    await expect(isSuppressed(fake.tx, "a@b.com", "mention", WORKSPACE_ID)).resolves.toBe(false);
    expect(fake.select).toHaveBeenCalledTimes(1);
  });

  it("short-circuits a non-suppressible template without issuing any query", async () => {
    const fake = fakeTx(["a@b.com"]);
    await expect(isSuppressed(fake.tx, "a@b.com", "welcome", null)).resolves.toBe(false);
    await expect(isSuppressed(fake.tx, "a@b.com", "invitation", WORKSPACE_ID)).resolves.toBe(false);
    await expect(isSuppressed(fake.tx, "a@b.com", "password_reset_request", null)).resolves.toBe(
      false,
    );
    // Mandatory mail never pays for a lookup, and `welcome` (null workspace)
    // never issues a query it could not scope.
    expect(fake.select).not.toHaveBeenCalled();
  });

  it("declares mention as the only suppressible template", () => {
    expect([...SUPPRESSIBLE_TEMPLATE_KEYS]).toEqual(["mention"]);
    expect(UNSUBSCRIBE_RELATED_ENTITY_TYPE).toBe("unsubscribe");
  });
});
