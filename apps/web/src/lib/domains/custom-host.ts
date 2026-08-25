/**
 * Part 73 — what a request arriving on a NON-PRIMARY host is allowed to do.
 *
 * PURE ON PURPOSE. `proxy.ts` owns the I/O (reading headers, calling the API's
 * `resolve` route, writing the response); this module owns the decision, so the
 * rules below are unit-testable without a Next.js runtime, a fetch double, or a
 * server.
 *
 * WHAT THE RULES ARE FOR. A custom host belongs to exactly ONE workspace, and a
 * visitor on `notes.acme.com` is, as far as that host is concerned, inside
 * Acme's workspace and nowhere else. The backend already enforces that — every
 * route re-authorizes workspace membership — so this is not the security
 * boundary. It is the coherence boundary: without it, a member of two
 * workspaces landing on Acme's branded host could navigate into the other
 * workspace's pages, and Acme's hostname would be showing somebody else's
 * content under Acme's branding and Acme's certificate.
 *
 * So the shape is deliberately narrow:
 *
 *   - an UNRESOLVED host is a 404. Nothing renders on a hostname this
 *     deployment cannot map to a verified workspace.
 *   - `/workspaces/<other-id>/…` is a 404 on this host. The path names a
 *     workspace, and it is not the one this host belongs to.
 *   - the workspace-switch endpoint is a 404 on this host: switching the
 *     selection cookie is precisely the operation a single-tenant host must not
 *     offer.
 *   - everything else renders, with the selection cookie pinned to this host's
 *     workspace so the shell opens the right one without a round trip.
 */

/** What the API's `GET /api/v1/domains/resolve` answered for this host. */
export interface ResolvedCustomHost {
  readonly workspaceId: string;
  readonly slug: string;
}

export type CustomHostDecision =
  /** Not a custom host at all — the primary app host or a loopback address. */
  | { readonly kind: "primary" }
  /** Render, and pin the selection cookie when it does not already match. */
  | { readonly kind: "allow"; readonly setWorkspaceCookie: string | null }
  /** Refuse: unknown host, or a path that names another workspace. */
  | { readonly kind: "not-found" };

/** The endpoint that rewrites the workspace-selection cookie. */
const WORKSPACE_SELECT_PATH = "/api/shell/workspace";

/** `/workspaces/<id>` — the only path segment that names a workspace. */
const WORKSPACE_PATH = /^\/workspaces\/([^/]+)/u;

/**
 * Is this host the deployment's own, rather than a tenant's?
 *
 * Loopback counts: `pnpm dev` is reached on `localhost`, `127.0.0.1` and `[::1]`
 * interchangeably, and none of them is a hostname a tenant could ever claim.
 */
export function isPrimaryHost(host: string, primaryHost: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "") return true;
  if (value === primaryHost.trim().toLowerCase()) return true;
  const withoutPort = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : (value.split(":")[0] ?? "");
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(withoutPort);
}

export interface CustomHostRouteInput {
  readonly host: string;
  readonly primaryHost: string;
  readonly pathname: string;
  readonly method: string;
  /** `null` when the API could not map this host to a verified workspace. */
  readonly resolved: ResolvedCustomHost | null;
  /** The workspace id currently in the selection cookie, if any. */
  readonly selectedWorkspaceId: string | null;
  /** `false` disables the whole feature: only primary/loopback hosts pass. */
  readonly enabled: boolean;
}

export function decideCustomHostRoute(input: CustomHostRouteInput): CustomHostDecision {
  if (isPrimaryHost(input.host, input.primaryHost)) return { kind: "primary" };
  // With the feature off, a non-primary host is not a tenant host — it is a
  // host this deployment has nothing to say about.
  if (!input.enabled) return { kind: "not-found" };
  if (input.resolved === null) return { kind: "not-found" };

  const named = WORKSPACE_PATH.exec(input.pathname);
  if (named !== null && named[1] !== input.resolved.workspaceId) {
    return { kind: "not-found" };
  }
  if (input.pathname === WORKSPACE_SELECT_PATH && input.method.toUpperCase() === "POST") {
    return { kind: "not-found" };
  }
  return {
    kind: "allow",
    setWorkspaceCookie:
      input.selectedWorkspaceId === input.resolved.workspaceId ? null : input.resolved.workspaceId,
  };
}
