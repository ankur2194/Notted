import { describe, expect, it } from "vitest";

import { accentStyle } from "./accent-style";

describe("accentStyle", () => {
  it("overrides the primary and ring custom properties together", () => {
    expect(accentStyle("#0f766e")).toEqual({
      "--color-primary": "#0f766e",
      "--color-ring": "#0f766e",
    });
  });

  it("accepts upper-case hex", () => {
    expect(accentStyle("#0F766E")).toEqual({
      "--color-primary": "#0F766E",
      "--color-ring": "#0F766E",
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a three-digit hex", "#fff"],
    ["a named colour", "red"],
    ["a hex with alpha", "#0f766e80"],
    // The one that matters: a CSS injection attempt must not become a style.
    ["a declaration break-out", "#000;} :root{--color-primary:red"],
    ["a url() payload", "url(https://evil.example/x)"],
  ])("emits no style for %s", (_label, value) => {
    expect(accentStyle(value)).toBeUndefined();
  });
});
