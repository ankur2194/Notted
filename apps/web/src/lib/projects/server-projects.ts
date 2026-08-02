import "server-only";

import {
  PROJECT_API_PATHS,
  type ProjectDetail,
  type ProjectListQuery,
  type ProjectPage,
} from "@notted/shared-types";
import {
  projectDetailSchema,
  projectListQuerySchema,
  projectPageSchema,
  uuidSchema,
} from "@notted/shared-validators";
import { cookies } from "next/headers";

import { publicEnvironment } from "@/config/public-environment";

type RawSearchValue = string | readonly string[] | undefined;
export type ProjectSearchParams = Readonly<Record<string, RawSearchValue>>;

export type ServerProjectListResult =
  | { readonly status: "ready"; readonly data: ProjectPage; readonly query: ProjectListQuery }
  | { readonly status: "unauthenticated" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

export type ServerProjectDetailResult =
  | { readonly status: "ready"; readonly data: ProjectDetail }
  | { readonly status: "unauthenticated" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

function first(value: RawSearchValue): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export function parseProjectSearchParams(raw: ProjectSearchParams = {}): ProjectListQuery {
  const rawPage = first(raw.page);
  const page = rawPage !== undefined && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  const rawStatus = first(raw.status);
  const status =
    rawStatus === "active" || rawStatus === "archived" || rawStatus === "completed"
      ? rawStatus
      : undefined;
  const rawName = first(raw.name)?.trim();
  const name =
    rawName !== undefined && rawName.length > 0 && rawName.length <= 255 ? rawName : undefined;
  const rawSortBy = first(raw.sortBy);
  const sortBy =
    rawSortBy === "name" ||
    rawSortBy === "createdAt" ||
    rawSortBy === "updatedAt" ||
    rawSortBy === "dueAt"
      ? rawSortBy
      : "updatedAt";
  const sortDirection = first(raw.sortDirection) === "asc" ? "asc" : "desc";
  const candidate = {
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    limit: "12",
    status,
    name,
    sortBy,
    sortDirection,
  };
  const parsed = projectListQuerySchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return projectListQuerySchema.parse({
    page: 1,
    limit: 12,
    sortBy: "updatedAt",
    sortDirection: "desc",
  });
}

function cookieHeader(values: Awaited<ReturnType<typeof cookies>>): string {
  return values
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

function apiCollectionPath(workspaceId: string): string {
  return PROJECT_API_PATHS.collection.replace(":workspaceId", encodeURIComponent(workspaceId));
}

function apiMemberPath(workspaceId: string, projectId: string): string {
  return PROJECT_API_PATHS.member
    .replace(":workspaceId", encodeURIComponent(workspaceId))
    .replace(":projectId", encodeURIComponent(projectId));
}

function listSearch(query: ProjectListQuery): URLSearchParams {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    sortBy: query.sortBy ?? "updatedAt",
    sortDirection: query.sortDirection ?? "desc",
  });
  if (query.status !== undefined) params.set("status", query.status);
  if (query.name !== undefined) params.set("name", query.name);
  return params;
}

export async function getServerProjectList(
  workspaceId: string,
  rawSearch: ProjectSearchParams = {},
): Promise<ServerProjectListResult> {
  const parsedWorkspaceId = uuidSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) return { status: "not-found" };
  const query = parseProjectSearchParams(rawSearch);
  const values = await cookies();
  const cookie = cookieHeader(values);
  try {
    const url = new URL(
      apiCollectionPath(parsedWorkspaceId.data),
      publicEnvironment.NEXT_PUBLIC_API_URL,
    );
    url.search = listSearch(query).toString();
    const response = await fetch(url, {
      cache: "no-store",
      headers: cookie.length === 0 ? undefined : { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401) return { status: "unauthenticated" };
    if (response.status === 403 || response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = projectPageSchema.safeParse(await response.json());
    return parsed.success
      ? { status: "ready", data: parsed.data, query }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function getServerProjectDetail(
  workspaceId: string,
  projectId: string,
): Promise<ServerProjectDetailResult> {
  const parsedWorkspaceId = uuidSchema.safeParse(workspaceId);
  const parsedProjectId = uuidSchema.safeParse(projectId);
  if (!parsedWorkspaceId.success || !parsedProjectId.success) return { status: "not-found" };
  const values = await cookies();
  const cookie = cookieHeader(values);
  try {
    const response = await fetch(
      new URL(
        apiMemberPath(parsedWorkspaceId.data, parsedProjectId.data),
        publicEnvironment.NEXT_PUBLIC_API_URL,
      ),
      {
        cache: "no-store",
        headers: cookie.length === 0 ? undefined : { cookie },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 401) return { status: "unauthenticated" };
    if (response.status === 403 || response.status === 404) return { status: "not-found" };
    if (!response.ok) return { status: "unavailable" };
    const parsed = projectDetailSchema.safeParse(await response.json());
    return parsed.success ? { status: "ready", data: parsed.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
