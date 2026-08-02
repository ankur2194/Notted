import type { ProjectListQuery } from "@notted/shared-types";

export function projectCollectionPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/projects`;
}

export function projectDetailPath(workspaceId: string, projectId: string): string {
  return `${projectCollectionPath(workspaceId)}/${encodeURIComponent(projectId)}`;
}

export function projectListHref(
  workspaceId: string,
  query: Partial<ProjectListQuery> = {},
): string {
  const params = new URLSearchParams();
  if (query.page !== undefined && query.page !== 1) params.set("page", String(query.page));
  if (query.status !== undefined) params.set("status", query.status);
  if (query.name !== undefined && query.name.length > 0) params.set("name", query.name);
  if (query.sortBy !== undefined) params.set("sortBy", query.sortBy);
  if (query.sortDirection !== undefined) params.set("sortDirection", query.sortDirection);
  const suffix = params.toString();
  return `${projectCollectionPath(workspaceId)}${suffix.length === 0 ? "" : `?${suffix}`}`;
}
