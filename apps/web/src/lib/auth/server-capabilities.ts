import "server-only";

import { AUTH_API_PATHS, type AuthCapabilities } from "@notted/shared-types";

import { publicEnvironment } from "@/config/public-environment";

export type AuthCapabilitiesResult =
  | { readonly status: "available"; readonly value: AuthCapabilities }
  | { readonly status: "unavailable" };

function isCapabilities(value: unknown): value is AuthCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.oauthProviders) &&
    candidate.oauthProviders.every(
      (provider) =>
        typeof provider === "object" &&
        provider !== null &&
        ["google", "github", "microsoft"].includes(
          String((provider as Record<string, unknown>).id),
        ) &&
        typeof (provider as Record<string, unknown>).label === "string",
    ) &&
    candidate.passkeyEnabled === true &&
    candidate.twoFactorEnabled === true &&
    typeof candidate.nonRememberedSessionSeconds === "number" &&
    typeof candidate.rememberedSessionSeconds === "number" &&
    typeof candidate.recentAuthenticationSeconds === "number"
  );
}

export async function getAuthCapabilities(): Promise<AuthCapabilitiesResult> {
  try {
    const response = await fetch(
      new URL(AUTH_API_PATHS.capabilities, publicEnvironment.NEXT_PUBLIC_API_URL),
      { cache: "no-store", signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return { status: "unavailable" };
    const body: unknown = await response.json();
    return isCapabilities(body) ? { status: "available", value: body } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
