// Part 19: workspace-scoping strategy — the pure Drizzle predicate helper.
//
// ADR 0009 names this helper as the canonical repository-layer primitive:
// every read/update/delete of a tenant-owned table MUST include this predicate;
// inserts use `activeWorkspaceId` and validate constrained parents. Absence of
// scope is a security bug.
//
// The helper takes a Drizzle table whose `workspaceId` column carries the
// tenant boundary and an active context reader. It calls `get()` itself before
// returning the canonical `eq(table.workspaceId, context.workspaceId)`
// predicate, so a missing context fails closed. Part 24+ services
// apply this in every repository method; Part 19 ships the primitive and the
// denial tests that prove it returns zero rows from any other tenant.
//
// Tables that do NOT carry `workspace_id` directly (junctions like `note_tags`,
// `task_tags`, `webhook_deliveries`, polymorphic children like `comments`,
// `note_versions`, `note_embeddings`) reach the workspace transitively via a
// parent. For those, scope by the PARENT table's `workspaceId` using a join:
//
//   select({ note: notes })
//     .from(notes)
//     .innerJoin(comments, eq(comments.noteId, notes.id))
//     .where(whereWorkspace(notes, tenantContext))
//
// The "junction tables have no direct workspace_id" choice is documented in
// Parts 16/17/18 (mutable membership makes a denormalized constraint racy; the
// composite-FK pattern does not apply to many-to-many edges).

import { eq, type AnyColumn, type SQL } from "drizzle-orm";

import { tenantWorkspaceMismatch } from "./tenant-errors";

import type { TenantContext } from "./tenant-context";

/** Minimal injectable context-reader contract needed by the scope helper. */
export interface ActiveTenantContext {
  get(): TenantContext;
}

/** Resolve the only workspace id tenant-owned inserts may persist. */
export function activeWorkspaceId(tenantContext: ActiveTenantContext): string {
  return tenantContext.get().workspaceId;
}

/**
 * Deny a resource mutation/read before SQL unless its authoritative workspace
 * matches the active server-side tenant context. `resourceWorkspaceId` must be
 * loaded from an already-scoped row or constrained parent, never from client
 * input alone.
 */
export function assertActiveWorkspace(
  resourceWorkspaceId: string | null | undefined,
  tenantContext: ActiveTenantContext,
  resource = "resource",
): asserts resourceWorkspaceId is string {
  if (
    resourceWorkspaceId === null ||
    resourceWorkspaceId === undefined ||
    resourceWorkspaceId !== activeWorkspaceId(tenantContext)
  ) {
    throw tenantWorkspaceMismatch(resource);
  }
}

/** Operation-specific repository boundaries. Keeping these entry points
 * distinct prevents a future repository from validating inserts while
 * accidentally omitting the equivalent read/update/delete guard. */
export function assertWorkspaceRead(
  resourceWorkspaceId: string | null | undefined,
  tenantContext: ActiveTenantContext,
  resource = "read",
): void {
  assertActiveWorkspace(resourceWorkspaceId, tenantContext, resource);
}

export function assertWorkspaceUpdate(
  resourceWorkspaceId: string | null | undefined,
  tenantContext: ActiveTenantContext,
  resource = "update",
): void {
  assertActiveWorkspace(resourceWorkspaceId, tenantContext, resource);
}

export function assertWorkspaceDelete(
  resourceWorkspaceId: string | null | undefined,
  tenantContext: ActiveTenantContext,
  resource = "delete",
): void {
  assertActiveWorkspace(resourceWorkspaceId, tenantContext, resource);
}

/**
 * Guard direct tenant-owned insert values before a repository constructs SQL.
 * Values are returned unchanged after validation to compose with typed Drizzle
 * `.values(...)` calls without widening their inferred insert type.
 */
export function assertWorkspaceInsertValues<
  T extends { readonly workspaceId: string | null | undefined },
>(values: T, tenantContext: ActiveTenantContext, resource = "insert"): T {
  assertActiveWorkspace(values.workspaceId, tenantContext, resource);
  return values;
}

/**
 * Shape of a Drizzle table that carries a `workspaceId` column directly. Every
 * tenant-owned table that carries `workspace_id` directly satisfies this
 * interface (projects, folders, notes, tags, attachments, tasks, task_statuses,
 * audit_logs, api_keys, webhooks, exports, ai_provider_config, ai_usage,
 * invitations, workspace_members, and email_deliveries (nullable).
 *
 * Junction/child tables that do NOT carry `workspace_id` directly
 * (`note_tags`, `task_tags`, `comments`, `note_versions`, `note_embeddings`,
 * `project_access`, `note_shares`, `webhook_deliveries`) intentionally do NOT
 * satisfy this interface; they must be scoped via a parent join (see module
 * comment).
 */
export interface WorkspaceScopedTable {
  readonly workspaceId: AnyColumn<{ data: string }>;
}

/**
 * Build the canonical `eq(table.workspaceId, context.workspaceId)` predicate
 * from the active AsyncLocalStorage context.
 *
 * RULE (ADR 0009): every tenant-owned read/update/delete MUST include this
 * predicate or a constrained-parent equivalent. Inserts use
 * {@link activeWorkspaceId} and validate constrained parents in the same
 * transaction via {@link assertWorkspaceInsertValues}. Existing-resource and
 * constrained-parent mutations call {@link assertActiveWorkspace} before SQL.
 * Reviewers and cross-tenant denial tests are the regression net.
 *
 * Example:
 *
 *   const rows = await db
 *     .select()
 *     .from(notes)
 *     .where(whereWorkspace(notes, tenantContext));
 *
 * Throws the typed `tenant.no_active_context` error when no active tenant
 * context is set. The helper calls `get()` itself so callers cannot accidentally
 * substitute an untrusted workspace id for the active server-side scope.
 */
export function whereWorkspace<T extends WorkspaceScopedTable>(
  table: T,
  tenantContext: ActiveTenantContext,
): SQL {
  return eq(table.workspaceId, activeWorkspaceId(tenantContext));
}

/**
 * Convenience: scope by the workspace's OWN primary key. Use this for queries
 * on the `workspaces` table itself, where the "tenant boundary" is the row's
 * own `id` rather than a `workspace_id` foreign key.
 *
 * Example:
 *
 *   const ws = await db
 *     .select()
 *     .from(workspaces)
 *     .where(whereWorkspaceId(workspaces, tenantContext));
 */
export interface WorkspaceRootTable {
  readonly id: AnyColumn<{ data: string }>;
}

export function whereWorkspaceId<T extends WorkspaceRootTable>(
  table: T,
  tenantContext: ActiveTenantContext,
): SQL {
  return eq(table.id, activeWorkspaceId(tenantContext));
}
