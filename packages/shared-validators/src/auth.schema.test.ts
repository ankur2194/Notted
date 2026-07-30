import { describe, expect, it } from "vitest";

import {
  authPasswordSchema,
  passkeyNameSchema,
  reauthenticateSchema,
  recoveryCodeSchema,
  registerWithPasswordSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  totpCodeSchema,
} from "./auth.schema";

describe("authentication request contracts", () => {
  it("requires the product password strength rules", () => {
    expect(authPasswordSchema.safeParse("Weakpassword1").success).toBe(false);
    expect(authPasswordSchema.safeParse("weakPassword!").success).toBe(false);
    expect(authPasswordSchema.safeParse("Strong1!").success).toBe(true);
  });

  it("normalizes email without exposing credential fields in response types", () => {
    const result = registerWithPasswordSchema.parse({
      name: "Notted User",
      email: "  USER@EXAMPLE.COM ",
      password: "Strong1!",
    });
    expect(result.email).toBe("user@example.com");
    expect(
      registerWithPasswordSchema.safeParse({
        name: "Notted User",
        email: "user@example.com",
        password: "Strong1!",
        rememberMe: true,
      }).success,
    ).toBe(false);
  });

  it("keeps forgotten-password input generic and validates reset credentials", () => {
    expect(requestPasswordResetSchema.parse({ email: "USER@example.com" })).toEqual({
      email: "user@example.com",
    });
    expect(
      resetPasswordSchema.safeParse({ token: "x".repeat(32), newPassword: "Strong1!" }).success,
    ).toBe(true);
  });

  it("bounds advanced authentication names and one-time inputs", () => {
    expect(passkeyNameSchema.parse("  Work laptop  ")).toBe("Work laptop");
    expect(passkeyNameSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(totpCodeSchema.safeParse("123456").success).toBe(true);
    expect(totpCodeSchema.safeParse("1234567").success).toBe(false);
    expect(recoveryCodeSchema.safeParse("ABCDE-FGHIJ").success).toBe(true);
    expect(reauthenticateSchema.safeParse({ password: "fixture", retained: true }).success).toBe(
      false,
    );
  });
});
