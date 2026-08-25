import { AsyncLocalStorage } from "node:async_hooks";

import type { Request } from "express";

const REQUEST_ID = Symbol("notted.requestId");

type RequestWithContext = Request & {
  [REQUEST_ID]?: string;
};

export function getRequestId(request: Request): string | undefined {
  return (request as RequestWithContext)[REQUEST_ID];
}

export function setRequestId(request: Request, requestId: string): void {
  (request as RequestWithContext)[REQUEST_ID] = requestId;
}

/**
 * Part 71 — the request facts an audit row records, carried across async hops.
 *
 * WHY AN ASYNCLOCALSTORAGE AND NOT THE TENANT CONTEXT. Audit writes happen deep
 * inside `AuthorizationEntryService.run()`, which rebuilds the tenant context
 * from `{ workspaceId, userId }` alone (`authorization-entry.service.ts`) — the
 * Express `Request` never reaches it, and neither does the IP or the user
 * agent. Threading them through every service signature would touch thirteen
 * writers and their transports for two nullable strings.
 *
 * One store entered by `RequestContextMiddleware` covers REST, tRPC and Better
 * Auth, because all three run behind the same `app.use`. Background jobs and
 * queue handlers have NO store, so `getRequestContext()` returns `null` there
 * and the audit row records `NULL` ip/user-agent — which is the truth: a sweep
 * has no client.
 *
 * Both strings are bounded at the boundary, not at the writer: `ip_address` is
 * `varchar(45)` (full IPv6) and `user_agent` is bounded so a hostile header
 * cannot make an audit row arbitrarily large.
 */
export interface RequestContext {
  readonly requestId: string;
  /** Client address, already truncated to the `varchar(45)` column width. */
  readonly ipAddress: string | null;
  /** Client `User-Agent`, truncated; empty is normalized to `null`. */
  readonly userAgent: string | null;
}

export const REQUEST_IP_MAX_LENGTH = 45;
export const REQUEST_USER_AGENT_MAX_LENGTH = 512;

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Bind `context` for the duration of `run`. Callback-bounded like
 * `TenantContextService.run`: there is no `enterWith`, so a handler that forgets
 * to await cannot leak one caller's address into the next request.
 */
export function runWithRequestContext<T>(context: RequestContext, run: () => T): T {
  return storage.run(context, run);
}

/** The active request facts, or `null` outside a request (jobs, workers, CLI). */
export function getRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}
