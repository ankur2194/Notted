import { PROJECT_API_PATHS } from "@notted/shared-types";
import {
  createProjectSchema,
  projectCreateResultSchema,
  projectDeleteResultSchema,
  projectStatusResultSchema,
  projectUpdateResultSchema,
  updateProjectSchema,
  uuidSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "@notted/shared-validators";

import type {
  ProjectCreateResult,
  ProjectDeleteResult,
  ProjectStatusResult,
  ProjectUpdateResult,
} from "@notted/shared-types";

import { publicEnvironment } from "@/config/public-environment";

export type ProjectRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "forbidden-or-not-found" | "conflict" | "unavailable";
    };

function apiPath(workspaceId: string, projectId?: string): string {
  const template =
    projectId === undefined ? PROJECT_API_PATHS.collection : PROJECT_API_PATHS.member;
  return template
    .replace(":workspaceId", encodeURIComponent(workspaceId))
    .replace(":projectId", encodeURIComponent(projectId ?? ""));
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Promise<ProjectRequestResult<T>> {
  try {
    const response = await fetch(new URL(path, publicEnvironment.NEXT_PUBLIC_API_URL), {
      ...init,
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) return { ok: false, kind: "invalid" };
      if ([401, 403, 404].includes(response.status)) {
        return { ok: false, kind: "forbidden-or-not-found" };
      }
      if (response.status === 409) return { ok: false, kind: "conflict" };
      return { ok: false, kind: "unavailable" };
    }
    const parsed = parse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}

function validIds(workspaceId: string, projectId?: string): boolean {
  return (
    uuidSchema.safeParse(workspaceId).success &&
    (projectId === undefined || uuidSchema.safeParse(projectId).success)
  );
}

export function createProject(
  workspaceId: string,
  input: CreateProjectInput,
  idempotencyKey: string,
): Promise<ProjectRequestResult<ProjectCreateResult>> {
  const parsed = createProjectSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    apiPath(workspaceId),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(parsed.data),
    },
    (value) => projectCreateResultSchema.safeParse(value),
  );
}

export function updateProject(
  workspaceId: string,
  projectId: string,
  input: UpdateProjectInput,
): Promise<ProjectRequestResult<ProjectUpdateResult>> {
  const parsed = updateProjectSchema.safeParse(input);
  if (!validIds(workspaceId, projectId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    apiPath(workspaceId, projectId),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    },
    (value) => projectUpdateResultSchema.safeParse(value),
  );
}

export function transitionProject(
  workspaceId: string,
  projectId: string,
  transition: "archive" | "complete" | "restore",
): Promise<ProjectRequestResult<ProjectStatusResult>> {
  if (!validIds(workspaceId, projectId)) return Promise.resolve({ ok: false, kind: "invalid" });
  const path = PROJECT_API_PATHS[transition]
    .replace(":workspaceId", encodeURIComponent(workspaceId))
    .replace(":projectId", encodeURIComponent(projectId));
  return requestJson(path, { method: "POST" }, (value) =>
    projectStatusResultSchema.safeParse(value),
  );
}

export function deleteProject(
  workspaceId: string,
  projectId: string,
): Promise<ProjectRequestResult<ProjectDeleteResult>> {
  if (!validIds(workspaceId, projectId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(apiPath(workspaceId, projectId), { method: "DELETE" }, (value) =>
    projectDeleteResultSchema.safeParse(value),
  );
}
