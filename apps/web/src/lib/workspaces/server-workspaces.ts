import "server-only";

import {
  WORKSPACE_API_PATHS,
  type WorkspaceDetail,
  type WorkspaceListQuery,
  type WorkspacePage,
  type WorkspaceStorageUsage,
} from "@notted/shared-types";
import {
  uuidSchema,
  workspaceDetailSchema,
  workspaceListQuerySchema,
  workspacePageSchema,
  workspaceStorageUsageSchema,
} from "@notted/shared-validators";
import { cookies } from "next/headers";

import { publicEnvironment } from "@/config/public-environment";
import { workspaceStoragePath } from "@/lib/workspaces/paths";

export type ServerWorkspaceListResult =
  | { readonly status: "ready"; readonly data: WorkspacePage }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" };

export type ServerWorkspaceDetailResult =
  | { readonly status: "ready"; readonly data: WorkspaceDetail }
  | { readonly status: "unauthenticated" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * Part 45 storage usage as the Server Component overview sees it.
 *
 * `forbidden` is kept distinct from `unavailable`: reading usage needs only
 * `settings.read`, so a denial is a membership fact worth stating plainly, while
 * `unavailable` is a fault the reader can do nothing about. Neither is allowed
 * to take down the page — the overview still renders the workspace it already
 * loaded and degrades only this one card.
 */
export type ServerWorkspaceStorageResult =
  | { readonly status: "ready"; readonly data: WorkspaceStorageUsage }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

function cookieHeader(values: Awaited<ReturnType<typeof cookies>>): string {
  return values
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

/**
 * Normalizes the optional list query through the shared Zod contract so the
 * server never forwards an unbounded or malformed filter to the API. Defaults
 * match `workspaceListQuerySchema` (page 1, limit 25, sort updatedAt desc).
 */
function buildListQuery(query?: Partial<WorkspaceListQuery>): URLSearchParams {
  const parsed = workspaceListQuerySchema.safeParse({
    page: query?.page ?? 1,
    limit: query?.limit ?? 25,
    name: query?.name,
    plan: query?.plan,
    currentUserRole: query?.currentUserRole,
    sortBy: query?.sortBy ?? "updatedAt",
    sortDirection: query?.sortDirection ?? "desc",
  });
  // safeParse only fails on out-of-range coercion; defaults keep this safe.
  if (!parsed.success) return new URLSearchParams();
  const { page, limit, name, plan, currentUserRole, sortBy, sortDirection } = parsed.data;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  params.set("sortBy", sortBy);
  params.set("sortDirection", sortDirection);
  if (name !== undefined) params.set("name", name);
  if (plan !== undefined) params.set("plan", plan);
  if (currentUserRole !== undefined) params.set("currentUserRole", currentUserRole);
  return params;
}

async function requestWorkspaceCollection(
  cookie: string,
  params: URLSearchParams,
): Promise<Response> {
  const url = new URL(WORKSPACE_API_PATHS.collection, publicEnvironment.NEXT_PUBLIC_API_URL);
  for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  return fetch(url, {
    cache: "no-store",
    headers: cookie.length > 0 ? { cookie } : undefined,
    signal: AbortSignal.timeout(5_000),
  });
}

async function requestWorkspaceMember(cookie: string, workspaceId: string): Promise<Response> {
  const url = new URL(
    WORKSPACE_API_PATHS.member.replace(":id", encodeURIComponent(workspaceId)),
    publicEnvironment.NEXT_PUBLIC_API_URL,
  );
  return fetch(url, {
    cache: "no-store",
    headers: cookie.length > 0 ? { cookie } : undefined,
    signal: AbortSignal.timeout(5_000),
  });
}

async function requestWorkspaceStorage(cookie: string, workspaceId: string): Promise<Response> {
  const url = new URL(workspaceStoragePath(workspaceId), publicEnvironment.NEXT_PUBLIC_API_URL);
  return fetch(url, {
    cache: "no-store",
    headers: cookie.length > 0 ? { cookie } : undefined,
    signal: AbortSignal.timeout(5_000),
  });
}

/**
 * Loads the derived storage usage for one workspace. Called only after the
 * detail read has already proved membership, so this never widens what the page
 * discloses: a caller that could not see the workspace never reaches here.
 */
export async function getServerWorkspaceStorageUsage(
  workspaceId: string,
): Promise<ServerWorkspaceStorageResult> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  if (!parsedId.success) return { status: "unavailable" };
  const values = await cookies();
  const cookie = cookieHeader(values);
  try {
    const response = await requestWorkspaceStorage(cookie, parsedId.data);
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { status: "forbidden" };
    }
    if (!response.ok) return { status: "unavailable" };
    const parsed = workspaceStorageUsageSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Lists the authenticated user's workspace memberships. The endpoint is
 * user-scoped (not workspace-scoped), so a 401/403 maps to an unauthenticated
 * result; any other failure fails closed as unavailable.
 */
export async function getServerWorkspaceList(
  query?: Partial<WorkspaceListQuery>,
): Promise<ServerWorkspaceListResult> {
  const values = await cookies();
  const cookie = cookieHeader(values);
  const params = buildListQuery(query);
  try {
    const response = await requestWorkspaceCollection(cookie, params);
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthenticated" };
    }
    if (!response.ok) return { status: "unavailable" };
    const parsed = workspacePageSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Loads a single workspace detail. Part 26 conceals unknown, cross-tenant, and
 * revoked-membership workspaces as 404 and insufficient-role reads as 403; both
 * map to a `not-found` result so the UI never discloses existence. All cookies
 * are forwarded so the API can prove membership; none are trusted client-side.
 */
export async function getServerWorkspaceDetail(
  workspaceId: string,
): Promise<ServerWorkspaceDetailResult> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  if (!parsedId.success) return { status: "not-found" };
  const values = await cookies();
  const cookie = cookieHeader(values);
  try {
    const response = await requestWorkspaceMember(cookie, parsedId.data);
    if (response.status === 401) return { status: "unauthenticated" };
    if (response.status === 403 || response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = workspaceDetailSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
