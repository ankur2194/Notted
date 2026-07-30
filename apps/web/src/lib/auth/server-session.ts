import "server-only";

import { AUTH_API_PATHS, type AuthenticatedPrincipal } from "@notted/shared-types";
import { cookies } from "next/headers";

import { publicEnvironment } from "@/config/public-environment";

export type ServerSessionResult =
  | { readonly status: "authenticated"; readonly principal: AuthenticatedPrincipal }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" };

function serializeCookies(values: Awaited<ReturnType<typeof cookies>>): string {
  return values
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

function isPrincipal(value: unknown): value is AuthenticatedPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" &&
    typeof candidate.sessionId === "string" &&
    candidate.method === "opaque-session" &&
    candidate.assurance === "single-factor" &&
    typeof candidate.expiresAt === "string" &&
    typeof candidate.authenticatedAt === "string" &&
    typeof candidate.isFresh === "boolean"
  );
}

/** Forwards only the current request cookies to the API and never logs them. */
export async function getServerSession(): Promise<ServerSessionResult> {
  const requestCookies = await cookies();
  const cookieHeader = serializeCookies(requestCookies);

  try {
    const response = await fetch(
      new URL(AUTH_API_PATHS.principalSession, publicEnvironment.NEXT_PUBLIC_API_URL),
      {
        cache: "no-store",
        headers: cookieHeader.length > 0 ? { cookie: cookieHeader } : undefined,
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (response.status === 401 || response.status === 403) {
      return { status: "unauthenticated" };
    }
    if (!response.ok) return { status: "unavailable" };

    const body: unknown = await response.json();
    return isPrincipal(body)
      ? { status: "authenticated", principal: body }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
