import "server-only";

import { SHELL_API_PATHS, type ShellBootstrap } from "@notted/shared-types";
import { shellBootstrapSchema, uuidSchema } from "@notted/shared-validators";
import { cookies } from "next/headers";

import { publicEnvironment } from "@/config/public-environment";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/shell/constants";

// Re-exported so the existing importers (the workspaces page, the selection
// route handler, and this module's own tests) keep their import path.
export { WORKSPACE_SELECTION_COOKIE };

export type ServerShellResult =
  | { readonly status: "ready"; readonly data: ShellBootstrap }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" };

function cookieHeader(values: Awaited<ReturnType<typeof cookies>>): string {
  return values
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

async function requestBootstrap(cookie: string, workspaceId?: string): Promise<Response> {
  const url = new URL(SHELL_API_PATHS.bootstrap, publicEnvironment.NEXT_PUBLIC_API_URL);
  if (workspaceId !== undefined) url.searchParams.set("workspaceId", workspaceId);
  return fetch(url, {
    cache: "no-store",
    headers: cookie.length > 0 ? { cookie } : undefined,
    signal: AbortSignal.timeout(5_000),
  });
}

export async function getServerShell(): Promise<ServerShellResult> {
  const values = await cookies();
  const forwardedCookies = cookieHeader(values);
  const selected = uuidSchema.safeParse(values.get(WORKSPACE_SELECTION_COOKIE)?.value);
  try {
    let response = await requestBootstrap(
      forwardedCookies,
      selected.success ? selected.data : undefined,
    );
    // A revoked/stale selection is never trusted. Fall back to the server's
    // first authorized membership rather than exposing or retaining its data.
    if (response.status === 404 && selected.success) {
      response = await requestBootstrap(forwardedCookies);
    }
    if (response.status === 401 || response.status === 403) return { status: "unauthenticated" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = shellBootstrapSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
