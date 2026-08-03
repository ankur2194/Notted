import { beforeEach, describe, expect, it, vi } from "vitest";

const { authClient } = vi.hoisted(() => ({
  authClient: {
    signIn: {
      email: vi.fn(),
      magicLink: vi.fn(),
      social: vi.fn(),
      passkey: vi.fn(),
    },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    sendVerificationEmail: vi.fn(),
    twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
    passkey: { addPasskey: vi.fn() },
    $fetch: vi.fn(),
  },
}));
vi.mock("@/lib/auth/auth-client", () => ({ authClient }));

import {
  addPasskey,
  deletePasskey,
  disableTwoFactor,
  enableTwoFactor,
  reauthenticate,
  regenerateRecoveryCodes,
  registerWithPassword,
  requestMagicLink,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signInWithOAuth,
  signInWithPasskey,
  signInWithPassword,
  signOut,
  verifyRecoveryCode,
  verifyTotp,
} from "@/lib/auth/requests";

const credentials = { email: "ada@example.test", password: "correct horse battery staple" };
const ok = { error: null, data: null };
const rejected = { error: { message: "Invalid credentials" }, data: null };

describe("auth requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a successful password sign-in", async () => {
    authClient.signIn.email.mockResolvedValue(ok);

    await expect(signInWithPassword(credentials)).resolves.toEqual({ ok: true });
    expect(authClient.signIn.email).toHaveBeenCalledWith(credentials);
  });

  /**
   * A rejected sign-in and a network failure must stay distinguishable: the
   * first is the user's problem to fix, the second is worth retrying. Neither
   * carries the server's message through — the caller renders a fixed string so
   * a provider error cannot become injected UI copy.
   */
  it("distinguishes a rejected sign-in from an unreachable server", async () => {
    authClient.signIn.email.mockResolvedValue(rejected);
    await expect(signInWithPassword(credentials)).resolves.toEqual({ ok: false, kind: "rejected" });

    authClient.signIn.email.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(signInWithPassword(credentials)).resolves.toEqual({ ok: false, kind: "network" });
  });

  it("surfaces a two-factor challenge with its offered methods", async () => {
    authClient.signIn.email.mockResolvedValue({
      error: null,
      data: { twoFactorRedirect: true, twoFactorMethods: ["totp", "backup_code"] },
    });

    await expect(signInWithPassword(credentials)).resolves.toEqual({
      ok: true,
      next: "two-factor",
      methods: ["totp", "backup_code"],
    });
  });

  it("defaults the offered methods to an empty list when the server omits them", async () => {
    authClient.signIn.email.mockResolvedValue({ error: null, data: { twoFactorRedirect: true } });

    await expect(signInWithPassword(credentials)).resolves.toEqual({
      ok: true,
      next: "two-factor",
      methods: [],
    });
  });

  it("treats a missing data envelope as a completed sign-in", async () => {
    authClient.signIn.email.mockResolvedValue({ error: null, data: null });

    await expect(signInWithPassword(credentials)).resolves.toEqual({ ok: true });
  });

  it.each([
    ["registerWithPassword", () => registerWithPassword({ ...credentials, name: "Ada" }), "signUp"],
    ["requestMagicLink", () => requestMagicLink({ email: credentials.email }), "signIn"],
    ["resendVerification", () => resendVerification({ email: credentials.email }), "send"],
    ["signOut", () => signOut(), "signOut"],
    ["signInWithPasskey", () => signInWithPasskey(), "passkey"],
    ["verifyTotp", () => verifyTotp("123456"), "twoFactor"],
    ["verifyRecoveryCode", () => verifyRecoveryCode("recovery"), "twoFactor"],
    ["addPasskey", () => addPasskey("Laptop"), "passkey"],
  ])("maps success, rejection, and network failure for %s", async (_name, invoke) => {
    const targets = [
      authClient.signUp.email,
      authClient.signIn.magicLink,
      authClient.signIn.passkey,
      authClient.sendVerificationEmail,
      authClient.signOut,
      authClient.twoFactor.verifyTotp,
      authClient.twoFactor.verifyBackupCode,
      authClient.passkey.addPasskey,
      authClient.$fetch,
    ];

    for (const target of targets) target.mockResolvedValue(ok);
    await expect(invoke()).resolves.toEqual({ ok: true });

    for (const target of targets) target.mockResolvedValue(rejected);
    await expect(invoke()).resolves.toEqual({ ok: false, kind: "rejected" });

    for (const target of targets) target.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(invoke()).resolves.toEqual({ ok: false, kind: "network" });
  });

  it("treats an undefined error field as success", async () => {
    authClient.signOut.mockResolvedValue({});

    await expect(signOut()).resolves.toEqual({ ok: true });
  });

  it("passes both callback URLs to the OAuth provider", async () => {
    authClient.signIn.social.mockResolvedValue(ok);

    await expect(
      signInWithOAuth("google", "https://app.test/after", "https://app.test/failed"),
    ).resolves.toEqual({ ok: true });
    expect(authClient.signIn.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "https://app.test/after",
      errorCallbackURL: "https://app.test/failed",
    });
  });

  it.each([
    ["requestPasswordReset", () => requestPasswordReset({ email: credentials.email })],
    [
      "resetPassword",
      () => resetPassword({ token: "reset-token", newPassword: "a-new-strong-password" }),
    ],
    ["reauthenticate", () => reauthenticate(credentials.password)],
    ["deletePasskey", () => deletePasskey("credential-1")],
    ["disableTwoFactor", () => disableTwoFactor(credentials.password)],
  ])("routes %s through the first-party endpoint", async (_name, invoke) => {
    authClient.$fetch.mockResolvedValue(ok);
    await expect(invoke()).resolves.toEqual({ ok: true });
    expect(authClient.$fetch.mock.calls[0]![1]).toMatchObject({ method: "POST" });

    authClient.$fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(invoke()).resolves.toEqual({ ok: false, kind: "network" });
  });

  it("omits the password body when two-factor is disabled without one", async () => {
    authClient.$fetch.mockResolvedValue(ok);

    await disableTwoFactor(undefined);

    expect(authClient.$fetch).toHaveBeenCalledWith("/two-factor/disable", {
      method: "POST",
      body: {},
    });
  });

  /**
   * Enrollment output is only usable if it is complete and well-formed: the
   * `otpauth://` prefix is what makes the QR code a valid authenticator import,
   * and a partially-typed recovery list would leave the user locked out with
   * codes that do not work. Anything short of that is reported as a failure
   * rather than half-rendered.
   */
  it("accepts a complete two-factor enrollment payload", async () => {
    authClient.$fetch.mockResolvedValue({
      error: null,
      data: { totpURI: "otpauth://totp/Notted:ada", backupCodes: ["one", "two"] },
    });

    await expect(enableTwoFactor(credentials.password)).resolves.toEqual({
      ok: true,
      totpURI: "otpauth://totp/Notted:ada",
      recoveryCodes: ["one", "two"],
    });
  });

  it("sends an empty body when enrolling without a password", async () => {
    authClient.$fetch.mockResolvedValue({
      error: null,
      data: { totpURI: "otpauth://totp/Notted:ada", backupCodes: [] },
    });

    await enableTwoFactor(undefined);

    expect(authClient.$fetch).toHaveBeenCalledWith("/two-factor/enable", {
      method: "POST",
      body: {},
    });
  });

  it.each([
    ["a rejected response", { error: { message: "no" }, data: null }],
    ["a null data envelope", { error: null, data: null }],
    [
      "a non-otpauth URI",
      { error: null, data: { totpURI: "https://example.test", backupCodes: [] } },
    ],
    ["a non-string URI", { error: null, data: { totpURI: 1, backupCodes: [] } }],
    [
      "recovery codes that are not an array",
      { error: null, data: { totpURI: "otpauth://totp/x", backupCodes: {} } },
    ],
    [
      "recovery codes that are not all strings",
      { error: null, data: { totpURI: "otpauth://totp/x", backupCodes: ["one", 2] } },
    ],
  ])("refuses an enrollment payload with %s", async (_label, response) => {
    authClient.$fetch.mockResolvedValue(response);

    await expect(enableTwoFactor(credentials.password)).resolves.toEqual({ ok: false });
  });

  it("reports a thrown enrollment request as a failure", async () => {
    authClient.$fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(enableTwoFactor(credentials.password)).resolves.toEqual({ ok: false });
  });

  it("returns regenerated recovery codes only when every entry is a string", async () => {
    authClient.$fetch.mockResolvedValue({ error: null, data: { backupCodes: ["one", "two"] } });
    await expect(regenerateRecoveryCodes(credentials.password)).resolves.toEqual({
      ok: true,
      recoveryCodes: ["one", "two"],
    });

    authClient.$fetch.mockResolvedValue({ error: null, data: { backupCodes: ["one", 2] } });
    await expect(regenerateRecoveryCodes(credentials.password)).resolves.toEqual({ ok: false });
  });

  it.each([
    ["a rejected response", { error: { message: "no" }, data: { backupCodes: [] } }],
    ["a null data envelope", { error: null, data: null }],
    ["a missing recovery list", { error: null, data: {} }],
  ])("refuses regenerated recovery codes with %s", async (_label, response) => {
    authClient.$fetch.mockResolvedValue(response);

    await expect(regenerateRecoveryCodes(credentials.password)).resolves.toEqual({ ok: false });
  });

  it("sends an empty body when regenerating without a password", async () => {
    authClient.$fetch.mockResolvedValue({ error: null, data: { backupCodes: [] } });

    await regenerateRecoveryCodes(undefined);

    expect(authClient.$fetch).toHaveBeenCalledWith("/two-factor/generate-backup-codes", {
      method: "POST",
      body: {},
    });
  });

  it("reports a thrown regeneration request as a failure", async () => {
    authClient.$fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(regenerateRecoveryCodes(credentials.password)).resolves.toEqual({ ok: false });
  });
});
