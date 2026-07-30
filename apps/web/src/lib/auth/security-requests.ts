import {
  AUTH_API_PATHS,
  type AuthenticatedPrincipal,
  type AuthSecurityOverview,
} from "@notted/shared-types";

import { publicEnvironment } from "@/config/public-environment";

export type SecurityRequestResult =
  { readonly ok: true } | { readonly ok: false; readonly recentAuthenticationRequired: boolean };

function isOverview(value: unknown): value is AuthSecurityOverview {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.twoFactorEnabled === "boolean" &&
    Array.isArray(candidate.sessions) &&
    Array.isArray(candidate.passkeys)
  );
}

export async function loadSecurityOverview(): Promise<AuthSecurityOverview | null> {
  try {
    const response = await fetch(
      new URL(AUTH_API_PATHS.security, publicEnvironment.NEXT_PUBLIC_API_URL),
      { cache: "no-store", credentials: "include", signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isOverview(body) ? body : null;
  } catch {
    return null;
  }
}

export async function loadPrincipal(): Promise<AuthenticatedPrincipal | null> {
  try {
    const response = await fetch(
      new URL(AUTH_API_PATHS.principalSession, publicEnvironment.NEXT_PUBLIC_API_URL),
      { cache: "no-store", credentials: "include", signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.userId === "string" && typeof candidate.sessionId === "string"
      ? (value as AuthenticatedPrincipal)
      : null;
  } catch {
    return null;
  }
}

async function mutate(url: URL, method: "POST" | "DELETE"): Promise<SecurityRequestResult> {
  try {
    const response = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, recentAuthenticationRequired: response.status === 403 };
  } catch {
    return { ok: false, recentAuthenticationRequired: false };
  }
}

export function revokeRemoteSession(sessionId: string): Promise<SecurityRequestResult> {
  const url = new URL(
    `${AUTH_API_PATHS.sessions}/${encodeURIComponent(sessionId)}`,
    publicEnvironment.NEXT_PUBLIC_API_URL,
  );
  return mutate(url, "DELETE");
}

export function revokeOtherSessions(): Promise<SecurityRequestResult> {
  return mutate(
    new URL(AUTH_API_PATHS.revokeOtherSessions, publicEnvironment.NEXT_PUBLIC_API_URL),
    "POST",
  );
}
