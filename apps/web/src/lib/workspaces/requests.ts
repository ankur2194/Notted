import {
  WORKSPACE_API_PATHS,
  type WorkspaceCreateResult,
  type WorkspaceDeleteResult,
  type WorkspaceLogoResult,
  type WorkspaceStorageUsage,
  type WorkspaceUpdateResult,
} from "@notted/shared-types";
import {
  createWorkspaceSchema,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  updateWorkspaceSchema,
  uuidSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceDeleteSchema,
  type WorkspaceDeleteInput,
  workspaceLogoResultSchema,
  workspaceStorageUsageSchema,
  workspaceUpdateResultSchema,
} from "@notted/shared-validators";

import { apiOrigin } from "@/lib/api/api-origin";
import {
  workspaceLogoPath,
  workspaceMemberPath,
  workspaceStoragePath,
} from "@/lib/workspaces/paths";

export type WorkspaceRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly kind: "forbidden" | "conflict" | "network" | "invalid";
    };

/**
 * Client mutations for the Part 26 workspace lifecycle endpoints. The API
 * enforces authentication, authorization, and trusted-origin; these helpers are
 * thin typed transports with a safe error union. Conflict is kept separate from
 * connectivity failures so settings can give an actionable slug/domain message.
 */
async function requestJson<T>(
  url: URL | string,
  init: RequestInit,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Promise<WorkspaceRequestResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { ok: false, kind: "forbidden" };
      }
      if (response.status === 409) return { ok: false, kind: "conflict" };
      if (response.status === 400 || response.status === 422) {
        return { ok: false, kind: "invalid" };
      }
      return { ok: false, kind: "network" };
    }
    const parsed = parse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function createWorkspace(
  input: CreateWorkspaceInput,
  idempotencyKey: string,
): Promise<WorkspaceRequestResult<WorkspaceCreateResult>> {
  // Validate the body before sending; trusted-origin is enforced by the API.
  const parsed = createWorkspaceSchema.safeParse(input);
  if (!parsed.success) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    new URL(WORKSPACE_API_PATHS.collection, apiOrigin()),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(parsed.data),
    },
    (value) => workspaceCreateResultSchema.safeParse(value),
  );
}

export function updateWorkspace(
  workspaceId: string,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceRequestResult<WorkspaceUpdateResult>> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  const parsedInput = updateWorkspaceSchema.safeParse(input);
  if (!parsedId.success || !parsedInput.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    new URL(workspaceMemberPath(parsedId.data), apiOrigin()),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsedInput.data),
    },
    (value) => workspaceUpdateResultSchema.safeParse(value),
  );
}

export function deleteWorkspace(
  workspaceId: string,
  input: WorkspaceDeleteInput,
): Promise<WorkspaceRequestResult<WorkspaceDeleteResult>> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  const parsed = workspaceDeleteSchema.safeParse(input);
  if (!parsedId.success || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    new URL(workspaceMemberPath(parsedId.data), apiOrigin()),
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    },
    (value) => workspaceDeleteResultSchema.safeParse(value),
  );
}

/**
 * Reads the Part 45 storage usage aggregate for one workspace.
 *
 * A GET, unlike the rest of this module, because usage is derived state rather
 * than a lifecycle mutation — but it reuses `requestJson` so the error union,
 * the timeout, and the credentialed no-store fetch stay identical.
 *
 * Reading requires only `settings.read`, so every role including `viewer` is
 * authorized; a `forbidden` result therefore means the membership changed
 * underneath the open page, not that the role is too low. The caller renders it
 * as a permission notice rather than a failure.
 */
export function requestWorkspaceStorageUsage(
  workspaceId: string,
): Promise<WorkspaceRequestResult<WorkspaceStorageUsage>> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  if (!parsedId.success) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    new URL(workspaceStoragePath(parsedId.data), apiOrigin()),
    { method: "GET", headers: { Accept: "application/json" } },
    (value) => workspaceStorageUsageSchema.safeParse(value),
  );
}

/**
 * Part 72 branding logo. `FormData` with one `file` part — deliberately NOT
 * `Content-Type: application/json` and deliberately no header set by hand: the
 * browser must write its own multipart boundary.
 *
 * The size ceiling is checked here purely so an oversize pick fails instantly
 * instead of after a 2 MiB upload. It is NOT the control — the API refuses the
 * body during transfer, before it is fully buffered.
 */
export const WORKSPACE_LOGO_MAX_BYTES = 2 * 1_024 * 1_024;

export function uploadWorkspaceLogo(
  workspaceId: string,
  file: File,
): Promise<WorkspaceRequestResult<WorkspaceLogoResult>> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  if (!parsedId.success || file.size > WORKSPACE_LOGO_MAX_BYTES || file.size === 0) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  const body = new FormData();
  body.append("file", file);
  return requestJson(
    new URL(workspaceLogoPath(parsedId.data), apiOrigin()),
    { method: "POST", headers: { Accept: "application/json" }, body },
    (value) => workspaceLogoResultSchema.safeParse(value),
  );
}

export function deleteWorkspaceLogo(
  workspaceId: string,
): Promise<WorkspaceRequestResult<WorkspaceLogoResult>> {
  const parsedId = uuidSchema.safeParse(workspaceId);
  if (!parsedId.success) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    new URL(workspaceLogoPath(parsedId.data), apiOrigin()),
    { method: "DELETE", headers: { Accept: "application/json" } },
    (value) => workspaceLogoResultSchema.safeParse(value),
  );
}

/**
 * Coerces a candidate slug from a free-text name. Mirrors the server's slug
 * rules (lower-case, digits, single hyphens) so the create dialog can preview a
 * valid suggestion without server round-trips. Empty results are left for the
 * shared schema to reject.
 */
export function suggestSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
