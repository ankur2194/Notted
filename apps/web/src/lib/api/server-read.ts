import "server-only";

import { cookies } from "next/headers";

import { publicEnvironment } from "@/config/public-environment";

export type ServerReadResult<T> =
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "unauthenticated" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

function cookieHeader(values: Awaited<ReturnType<typeof cookies>>): string {
  return values
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

/**
 * One authenticated read on behalf of the current request, for Server
 * Components only.
 *
 * 403 and 404 collapse to `not-found` on purpose: a workspace the caller may
 * not see must not be distinguishable from one that does not exist. Anything
 * unparseable is `unavailable` rather than `ready` with partial data.
 */
export async function readJson<T>(
  path: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Promise<ServerReadResult<T>> {
  const values = await cookies();
  const cookie = cookieHeader(values);
  try {
    const response = await fetch(new URL(path, publicEnvironment.NEXT_PUBLIC_API_URL), {
      cache: "no-store",
      headers: cookie.length === 0 ? undefined : { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401) return { status: "unauthenticated" };
    if (response.status === 403 || response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = parse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
