import type { OAuthProviderId } from "@notted/shared-types";
import type {
  RegisterWithPasswordInput,
  RequestEmailVerificationInput,
  RequestMagicLinkInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  SignInWithPasswordInput,
} from "@notted/shared-validators";

import { authClient } from "@/lib/auth/auth-client";

export type AuthRequestResult =
  | { readonly ok: true; readonly next?: "two-factor"; readonly methods?: readonly string[] }
  | { readonly ok: false; readonly kind: "rejected" | "network" };

function resultFromResponse(response: { readonly error: unknown }): AuthRequestResult {
  return response.error === null || response.error === undefined
    ? { ok: true }
    : { ok: false, kind: "rejected" };
}

async function resilientRequest(
  request: () => Promise<{ readonly error: unknown }>,
): Promise<AuthRequestResult> {
  try {
    return resultFromResponse(await request());
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function signInWithPassword(input: SignInWithPasswordInput): Promise<AuthRequestResult> {
  return signInWithPasswordAdvanced(input);
}

export async function signInWithPasswordAdvanced(
  input: SignInWithPasswordInput,
): Promise<AuthRequestResult> {
  try {
    const response = await authClient.signIn.email(input);
    if (response.error !== null) return { ok: false, kind: "rejected" };
    const data = response.data as {
      readonly twoFactorRedirect?: boolean;
      readonly twoFactorMethods?: readonly string[];
    } | null;
    return data?.twoFactorRedirect === true
      ? { ok: true, next: "two-factor", methods: data.twoFactorMethods ?? [] }
      : { ok: true };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function registerWithPassword(input: RegisterWithPasswordInput): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.signUp.email(input));
}

export function requestMagicLink(input: RequestMagicLinkInput): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.signIn.magicLink(input));
}

export function resendVerification(
  input: RequestEmailVerificationInput,
): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.sendVerificationEmail(input));
}

export function requestPasswordReset(input: RequestPasswordResetInput): Promise<AuthRequestResult> {
  return resilientRequest(() =>
    authClient.$fetch("/notted/request-password-reset", { method: "POST", body: input }),
  );
}

export function resetPassword(input: ResetPasswordInput): Promise<AuthRequestResult> {
  return resilientRequest(() =>
    authClient.$fetch("/notted/reset-password", { method: "POST", body: input }),
  );
}

export function signOut(): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.signOut());
}

export function signInWithOAuth(
  provider: OAuthProviderId,
  callbackURL: string,
  errorCallbackURL: string,
): Promise<AuthRequestResult> {
  return resilientRequest(() =>
    authClient.signIn.social({ provider, callbackURL, errorCallbackURL }),
  );
}

export function signInWithPasskey(): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.signIn.passkey());
}

export function reauthenticate(password: string): Promise<AuthRequestResult> {
  return resilientRequest(() =>
    authClient.$fetch("/notted/reauthenticate", { method: "POST", body: { password } }),
  );
}

export function verifyTotp(code: string): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.twoFactor.verifyTotp({ code }));
}

export function verifyRecoveryCode(code: string): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.twoFactor.verifyBackupCode({ code }));
}

export async function addPasskey(name: string): Promise<AuthRequestResult> {
  return resilientRequest(() => authClient.passkey.addPasskey({ name }));
}

export function deletePasskey(id: string): Promise<AuthRequestResult> {
  return resilientRequest(() =>
    authClient.$fetch("/passkey/delete-passkey", { method: "POST", body: { id } }),
  );
}

export interface TwoFactorEnrollmentResult {
  readonly ok: true;
  readonly totpURI: string;
  readonly recoveryCodes: readonly string[];
}

export async function enableTwoFactor(
  password: string | undefined,
): Promise<TwoFactorEnrollmentResult | { readonly ok: false }> {
  try {
    const response = await authClient.$fetch("/two-factor/enable", {
      method: "POST",
      body: password === undefined ? {} : { password },
    });
    const data = response.data as {
      readonly totpURI?: unknown;
      readonly backupCodes?: unknown;
    } | null;
    return response.error === null &&
      typeof data?.totpURI === "string" &&
      data.totpURI.startsWith("otpauth://") &&
      Array.isArray(data.backupCodes) &&
      data.backupCodes.every((code) => typeof code === "string")
      ? { ok: true, totpURI: data.totpURI, recoveryCodes: data.backupCodes }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function disableTwoFactor(password: string | undefined): Promise<AuthRequestResult> {
  return resilientRequest(() =>
    authClient.$fetch("/two-factor/disable", {
      method: "POST",
      body: password === undefined ? {} : { password },
    }),
  );
}

export async function regenerateRecoveryCodes(
  password: string | undefined,
): Promise<
  { readonly ok: true; readonly recoveryCodes: readonly string[] } | { readonly ok: false }
> {
  try {
    const response = await authClient.$fetch("/two-factor/generate-backup-codes", {
      method: "POST",
      body: password === undefined ? {} : { password },
    });
    const data = response.data as { readonly backupCodes?: unknown } | null;
    return response.error === null &&
      Array.isArray(data?.backupCodes) &&
      data.backupCodes.every((code) => typeof code === "string")
      ? { ok: true, recoveryCodes: data.backupCodes }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
