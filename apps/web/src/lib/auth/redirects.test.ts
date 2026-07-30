import { describe, expect, it } from "vitest";

import { loginPathFor, safeRedirectPath } from "@/lib/auth/redirects";

describe("safeRedirectPath", () => {
  it.each([
    ["/", "/"],
    ["/workspaces", "/workspaces"],
    ["/workspaces?view=recent#today", "/workspaces?view=recent#today"],
  ])("accepts local application target %s", (value, expected) => {
    expect(safeRedirectPath(value)).toBe(expected);
  });

  it.each([
    "https://evil.test",
    "//evil.test/path",
    "/\\evil.test",
    "javascript:alert(1)",
    "data:text/html,bad",
    "/%2f%2fevil.test",
    "/%5cevil.test",
    "/%0d%0aLocation:https://evil.test",
    "/login?redirect=/workspaces",
    "/register",
    "/reset-password",
    "/verify-email",
    "/magic-link",
    "/safe\u0000path",
  ])("rejects unsafe or looping target %s", (value) => {
    expect(safeRedirectPath(value)).toBe("/");
  });

  it("constructs an encoded login return path", () => {
    expect(loginPathFor("/workspaces?view=recent")).toBe(
      "/login?redirect=%2Fworkspaces%3Fview%3Drecent",
    );
  });
});
