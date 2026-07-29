// Part 19: tenant-context infrastructure barrel.
//
// Re-exports the public API of the tenant-context module so consumers depend
// on the module barrel rather than individual files. Phase 4 services import
// from here: `import { TenantContextService, whereWorkspace, type TenantContext }
// from "../tenant"`.
//
// ADR 0009 is the authoritative reference for the strategy documented here;
// the actual service-layer enforcement (applying `whereWorkspace` inside every
// repository method) is Part 24+.

export { TenantContextModule } from "./tenant-context.module";
export { TenantContextService } from "./tenant-context.service";
export {
  TENANT_ERROR_CODES,
  TenantError,
  noActiveTenantContext,
  tenantWorkspaceMismatch,
  type TenantErrorCode,
} from "./tenant-errors";
export { createTenantContext, type TenantContext } from "./tenant-context";
export {
  activeWorkspaceId,
  assertActiveWorkspace,
  assertWorkspaceDelete,
  assertWorkspaceInsertValues,
  assertWorkspaceRead,
  assertWorkspaceUpdate,
  whereWorkspace,
  whereWorkspaceId,
  type ActiveTenantContext,
  type WorkspaceRootTable,
  type WorkspaceScopedTable,
} from "./workspace-scope";
