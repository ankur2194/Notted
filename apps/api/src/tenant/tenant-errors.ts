// Part 19: typed errors for tenant-context and scoping failures.
//
// These errors are the explicit "deny by default" surface: when
// `TenantContextService.get()` is called outside a `run` scope, the helper
// throws instead of allowing an unscoped query.
//
// Part 24 maps these to the appropriate HTTP/tRPC error codes; until then they
// are NestJS-agnostic typed errors. Avoiding `@nestjs/common`'s `HttpException`
// keeps this module portable across jobs, WebSocket handlers, and processors.

/** Machine-readable codes for {@link TenantError}. */
export const TENANT_ERROR_CODES = [
  /**
   * Raised by `TenantContextService.get()` when no active context is set on the
   * current async chain. Deny by default: a tenant-owned query without a scope
   * is a bug, and surfacing it as a typed error prevents silent cross-tenant
   * access.
   */
  "tenant.no_active_context",
  /** Raised before SQL when a resource or insert belongs to another workspace. */
  "tenant.workspace_mismatch",
] as const;

export type TenantErrorCode = (typeof TENANT_ERROR_CODES)[number];

/**
 * Typed error for tenant-context and scoping failures. NestJS-agnostic so it
 * can be thrown from repositories, jobs, and WebSocket handlers alike; Part 24
 * maps it to transport-specific error codes.
 */
export class TenantError extends Error {
  readonly code: TenantErrorCode;

  constructor(code: TenantErrorCode, message: string) {
    super(message);
    this.name = "TenantError";
    this.code = code;
    // Restore the prototype chain for ES5 transpilation targets; without this,
    // `instanceof TenantError` can fail after a `throw` across module
    // boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Convenience constructor for the "no active tenant context" deny-by-default
 * case. Exposed so call sites do not need to import the code constant.
 */
export function noActiveTenantContext(message?: string): TenantError {
  return new TenantError(
    "tenant.no_active_context",
    message ??
      "No active tenant context: every tenant-owned query must run inside TenantContextService.run().",
  );
}

/** Build the typed pre-SQL denial for a cross-workspace resource identifier. */
export function tenantWorkspaceMismatch(resource: string): TenantError {
  return new TenantError(
    "tenant.workspace_mismatch",
    `Tenant workspace mismatch: ${resource} does not belong to the active workspace.`,
  );
}
