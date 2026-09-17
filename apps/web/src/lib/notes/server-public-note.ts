import "server-only";

import { NOTE_API_PATHS } from "@notted/shared-types";
import { publicNoteSchema, publicNoteTokenSchema } from "@notted/shared-validators";

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
    const response = await fetch(
      new URL(NOTE_API_PATHS.publicNote(parsedToken.data), publicEnvironment.NEXT_PUBLIC_API_URL),
      { cache: "no-store", signal: AbortSignal.timeout(5_000) },
    );
    if (response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = publicNoteSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
