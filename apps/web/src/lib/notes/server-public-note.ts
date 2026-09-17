import "server-only";

import { NOTE_API_PATHS } from "@notted/shared-types";
import { publicNoteSchema, publicNoteTokenSchema } from "@notted/shared-validators";
import { headers } from "next/headers";

import type { PublicNote } from "@notted/shared-types";

import { publicEnvironment } from "@/config/public-environment";

export type PublicNoteResult =
  | { readonly status: "ready"; readonly data: PublicNote }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * Server-side fetch for the `/p/:token` route. No cookies, no credentials:
 * the visitor is by definition anonymous. `not-found` covers every failure
 * mode the API's `PublicNoteController` collapses to 404 (missing, revoked,
 * trashed-note, malformed token) — deliberately uniform, matching the API's
 * own non-distinguishing 404 contract.
 */
export async function getPublicNote(token: string): Promise<PublicNoteResult> {
  const parsedToken = publicNoteTokenSchema.safeParse(token);
  if (!parsedToken.success) return { status: "not-found" };
  try {
    // This is a server-side fetch, so without forwarding the visitor's own
    // address every anonymous view would arrive at the API from this Next.js
    // server's single IP, collapsing the API's per-IP unauthenticated rate
    // limit into one shared bucket for all public-link traffic. The reverse
    // proxy in front of the web app sets `x-forwarded-for` on the incoming
    // request; take its left-most (closest-to-visitor) entry.
    const incomingHeaders = await headers();
    const visitorIp = incomingHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
    const response = await fetch(
      new URL(NOTE_API_PATHS.publicNote(parsedToken.data), publicEnvironment.NEXT_PUBLIC_API_URL),
      {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
        headers: visitorIp ? { "X-Forwarded-For": visitorIp } : undefined,
      },
    );
    if (response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = publicNoteSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
