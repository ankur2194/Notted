import { describe, expect, it } from "vitest";

import {
  PRESENCE_COLOR_COUNT,
  presenceColorForUser,
  presenceColorIndex,
  presenceColorVar,
} from "./user-color";

describe("presenceColorIndex", () => {
  it("is stable and inside the palette", () => {
    // Determinism is the whole contract: the API runs the same hash to mint the
    // roster's `colorIndex`, so a drift here would make a writer one colour to
    // themselves and another colour to everyone else.
    for (const userId of ["", "a", "9c858901-8a57-4791-81fe-4c455b099bc9"]) {
      const index = presenceColorIndex(userId);
      expect(index).toBe(presenceColorIndex(userId));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PRESENCE_COLOR_COUNT);
    }
  });

  it("agrees with the string form", () => {
    const userId = "9c858901-8a57-4791-81fe-4c455b099bc9";
    expect(presenceColorForUser(userId)).toBe(presenceColorVar(presenceColorIndex(userId)));
  });
});

describe("presenceColorVar", () => {
  it("clamps an index that arrived over the socket", () => {
    // Never `var(--notted-presence-undefined)`, which paints nothing.
    expect(presenceColorVar(3)).toBe("var(--notted-presence-3)");
    expect(presenceColorVar(11)).toBe("var(--notted-presence-3)");
    expect(presenceColorVar(-3)).toBe("var(--notted-presence-3)");
    expect(presenceColorVar(3.7)).toBe("var(--notted-presence-3)");
    expect(presenceColorVar(Number.NaN)).toBe("var(--notted-presence-0)");
    expect(presenceColorVar(Number.POSITIVE_INFINITY)).toBe("var(--notted-presence-0)");
  });
});
