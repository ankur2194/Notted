import { describe, expect, it } from "vitest";

import { betterAuthCookieAttributes } from "./better-auth.setup";

describe("Better Auth cookie policy", () => {
  it("uses opaque HTTP-only SameSite cookies and requires Secure in production", () => {
    expect(betterAuthCookieAttributes(false)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    expect(betterAuthCookieAttributes(true)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
