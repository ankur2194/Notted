// Part 19: AsyncLocalStorage-backed active tenant/user context.
//
// ADR 0009 chooses repository-layer enforcement with a transaction-local
// tenant/user context. This service is the canonical holder of that context:
// it uses Node's `AsyncLocalStorage<TenantContext>` to make the active
// `{ workspaceId, userId, requestId? }` available across async hops within a
// request/transaction/WebSocket-message/job WITHOUT threading the workspace id
// through every service signature.
//
// Lifecycle expectations (Part 21+ wires the actual middleware/guards; Part 19
// only provides the primitive):
// - HTTP/tRPC request: a boundary middleware calls `run(context, () =>
//   next())` after the Part 24 policy layer has resolved workspace membership.
// - Background job (Part 50/51 dispatcher): the processor calls
//   `run(context, () => serviceCall())` with the recorded actor/workspace
//   BEFORE invoking the application service.
// - WebSocket message (Part 33+): the gateway calls `run(context, () =>
//   handler())` for each inbound message. Context is deliberately callback-
//   bounded and is never mutated on a long-lived connection.
// - Transaction: services that need the context inside a Drizzle
//   `db.transaction(...)` continue to read it via `get()`/`tryGet()` — the
//   ALS store propagates across the transaction callback's async hops.
//
// Why AsyncLocalStorage (rather than a per-request decorator or a request
// object): the same context must reach nested service calls, repository
// helpers, and audit-log writes that do not have a request object in scope.
// ALS is Node's supported mechanism for request-scoped state across the full
// async chain; pino, NestJS request-scoped providers, and OpenTelemetry all
// rely on the same primitive.

import { AsyncLocalStorage } from "node:async_hooks";

import { Injectable } from "@nestjs/common";

import { noActiveTenantContext } from "./tenant-errors";

import type { TenantContext } from "./tenant-context";

@Injectable()
export class TenantContextService {
  /**
   * The single AsyncLocalStorage instance for the active context. One per
   * service (singleton). Re-using the same instance across `run` calls
   * is what makes the store available to nested async helpers.
   */
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  /**
   * Establish `context` as the active tenant context for the duration of `fn`,
   * restoring the prior context (if any) when `fn` resolves or rejects. This
   * is the SAFE, RECOMMENDED entry point: it bounds the context to `fn`, so a
   * request handler that forgets to await `next()` cannot leak the workspace
   * scope into the next request on a reused connection.
   *
   * Use this at every request/job/transaction boundary that establishes a
   * workspace scope.
   */
  run<T>(context: TenantContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  /**
   * Return the active {@link TenantContext}. Throws a typed
   * {@link TenantError} (`tenant.no_active_context`) when no context is set on
   * the current async chain — DENY BY DEFAULT. A tenant-owned query without a
   * scope is a security bug; surfacing it as an explicit error prevents silent
   * cross-tenant reads.
   *
   * Call this inside every service repository method that touches a
   * tenant-owned table. Do NOT swallow the error: a `catch` that falls through
   * to an unscoped query defeats the boundary.
   */
  get(): TenantContext {
    const store = this.storage.getStore();
    if (store === undefined) {
      throw noActiveTenantContext();
    }
    return store;
  }

  /**
   * Return the active {@link TenantContext} or `null` when no context is set.
   * Use this only for code that legitimately runs outside a workspace scope
   * (owning maintenance jobs in Parts 45/50/55/71, schema introspection, the Part 12
   * migration probe). Tenant-owned queries MUST use {@link get} so a missing
   * scope surfaces as an error rather than a silent unscoped read.
   */
  tryGet(): TenantContext | null {
    return this.storage.getStore() ?? null;
  }

  // No `set`, `clear`, `enterWith`, `exit`, or `disable` API is exposed.
  // Mutation would make scope lifetime depend on the surrounding async chain
  // and could leak one workspace into unrelated work. `run` is the sole scope-
  // establishment primitive and always restores the prior store.
}
