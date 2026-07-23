import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn utility", () => {
  it("joins class names correctly", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("handles conditional classes", () => {
    const isConditional = true;
    const isHidden = false;
    expect(cn("base", isConditional && "conditional", isHidden && "hidden")).toBe(
      "base conditional",
    );
  });

  it("handles tailwind-merge conflicts", () => {
    expect(cn("p-2 p-4", "m-1")).toBe("p-4 m-1");
  });

  it("handles empty and undefined values", () => {
    expect(cn("a", "", undefined, null, "b")).toBe("a b");
  });
});
