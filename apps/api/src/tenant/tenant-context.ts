// Part 19: the active tenant/user context for repository-layer enforcement.
//
// ADR 0009 decides Notted's tenant-protection strategy: repository-layer
// enforcement with a transaction-local tenant/user context (NOT PostgreSQL
// RLS). This module exports the context SHAPE only; the AsyncLocalStorage-
// backed service lives in `tenant-context.service.ts`, the typed error lives
// in `tenant-errors.ts`, and the Drizzle scoping helper lives in
// `workspace-scope.ts`.
//
// Why a context object rather than passing `workspaceId` through every
// signature:
// - ADR 0007 mandates every tenant-owned row carry or reach `workspace_id`, so
//   the workspace boundary is uniform. A context object makes the active
//   boundary available across async hops (request handlers, transactions,
//   WebSocket messages, background jobs) without forcing every helper to
//   re-thread the id.
// - Combined with the `whereWorkspace(table, context)` helper and a typed
//   "no active tenant context" error from `get()`, a forgotten scope surfaces
//   as an explicit error rather than a silent cross-tenant read.
//
// Why `userId` is nullable: a small number of legitimate operations run inside
// a workspace scope WITHOUT a user actor — for example, a webhook dispatcher
// (Part 66) re-delivering under narrow system authority, or a system-initiated
// AI/embeddings job (Parts 53/67) acting on workspace data. The workspace
// boundary still applies; only the actor field is absent. Code that requires a
// user (audit logging, "created_by_id" inserts) MUST re-check `userId` and
// reject when null rather than treating null as anonymous-but-permitted.

/**
 * The active tenant context. `workspaceId` is REQUIRED for every operation
 * that touches a tenant-owned table; `userId` is nullable for system-in-workspace
 * operations (see module comment); `requestId` is the optional correlation id
 * already propagated by `RequestContextMiddleware`.
 */
export interface TenantContext {
  /**
   * The active workspace boundary. Every tenant-owned query MUST be scoped to
   * this id (directly via `whereWorkspace`, or transitively via a constrained
   * parent). Platform operations that do not have a workspace scope must not
   * use tenant repositories; there is no "global workspace" context.
   */
  readonly workspaceId: string;

  /**
   * The acting user, when the operation is user-initiated. NULL when the
   * operation is system-initiated but still workspace-scoped (Part 66
   * redeliveries, Part 53/67 indexing/AI jobs). Code that requires a user
   * (audit logs, "created_by_id" columns) MUST reject null explicitly.
   */
  readonly userId: string | null;

  /**
   * Optional request/correlation id, propagated from
   * `RequestContextMiddleware` so audit logs and structured logs can correlate
   * a tenant-scoped operation back to the originating request. NULL when the
   * context was established by a background job with no inbound request.
   */
  readonly requestId?: string | null;
}

/**
 * Build an immutable {@link TenantContext}. Use this factory in transit
 * boundaries (request middleware, job dispatch) so a half-built context cannot
 * be mutated by the caller after passing it in.
 */
export function createTenantContext(input: {
  readonly workspaceId: string;
  readonly userId?: string | null;
  readonly requestId?: string | null;
}): TenantContext {
  return Object.freeze({
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    requestId: input.requestId ?? null,
  });
}
