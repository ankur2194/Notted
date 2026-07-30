import { describe, expect, it, vi } from "vitest";

import {
  parseSidebarPreference,
  readSidebarPreference,
  writeSidebarPreference,
} from "./sidebar-preference";

describe("sidebar preference", () => {
  it("accepts only the harmless closed value", () => {
    expect(parseSidebarPreference("collapsed")).toBe("collapsed");
    expect(parseSidebarPreference("expanded")).toBe("expanded");
    expect(parseSidebarPreference('{"workspaces":["secret"]}')).toBe("expanded");
  });

  it("falls back when storage is unavailable", () => {
    expect(
      readSidebarPreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("expanded");
    const setItem = vi.fn(() => {
      throw new Error("quota");
    });
    expect(() => writeSidebarPreference({ setItem }, "collapsed")).not.toThrow();
  });
});
