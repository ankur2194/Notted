import { setWorkspaceDomainSchema, workspaceDomainResultSchema } from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type { WorkspaceDomainResult } from "@notted/shared-types";

import { json, requestJson, validIds } from "@/lib/api/request-json";
import { workspaceDomainPath, workspaceDomainVerifyPath } from "@/lib/workspaces/paths";

/**
 * Part 73 — the browser half of the workspace custom domain.
 *
 * Modelled on `@/lib/audit-logs/requests`: the workspace id is checked before a
 * request is allowed to leave, and every response is `safeParse`d against the
 * shared result schema so an off-contract body is a failure rather than a silent
 * cast. All four routes answer with the SAME shape, so they share one parser.
 *
 * `requestJson` resolves the path against `apiOrigin()` itself, which is what
 * makes these calls work unchanged on a tenant host: on `notes.acme.com` the
 * API is addressed same-origin so the host-only session cookie is attached.
 *
 * The routes are admin-only server-side (`settings.read` / `settings.update`).
 * A 403 and a 404 both collapse to `kind: "forbidden-or-not-found"`, and on the
 * initial read a 404 ALSO means custom domains are disabled on this deployment
 * — the surface writes one message that is honest about both.
 */
const parse = (value: unknown) => workspaceDomainResultSchema.safeParse(value);

/** The workspace's claimed hostname, or `{ domain: null }` when it has none. */
export function loadWorkspaceDomain(
  workspaceId: string,
): Promise<ApiRequestResult<WorkspaceDomainResult>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(workspaceDomainPath(workspaceId), {}, parse);
}

/**
 * Claims a hostname. The value is normalised by the SHARED schema before it is
 * sent, so the browser cannot store a spelling the server would fold into a
 * different row; the server re-validates and remains the authority (409
 * `DOMAIN_TAKEN`, 422 `DOMAIN_RESERVED`).
 */
export function setWorkspaceDomain(
  workspaceId: string,
  hostname: string,
): Promise<ApiRequestResult<WorkspaceDomainResult>> {
  const parsed = setWorkspaceDomainSchema.safeParse({ hostname });
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(workspaceDomainPath(workspaceId), json("PUT", parsed.data), parse);
}

/** Re-runs the DNS check. Idempotent, so no idempotency key is needed. */
export function verifyWorkspaceDomain(
  workspaceId: string,
): Promise<ApiRequestResult<WorkspaceDomainResult>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(workspaceDomainVerifyPath(workspaceId), { method: "POST" }, parse);
}

/** Releases the hostname. Answers `{ domain: null }`. */
export function removeWorkspaceDomain(
  workspaceId: string,
): Promise<ApiRequestResult<WorkspaceDomainResult>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(workspaceDomainPath(workspaceId), { method: "DELETE" }, parse);
}
