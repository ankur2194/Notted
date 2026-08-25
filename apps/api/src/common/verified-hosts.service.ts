// Part 73 — the one answer to "may this host reach this API?".
//
// WHY IT LIVES IN `common/` AND NOT `domains/`. Three callers need it and one of
// them is `AuthService`: the CORS callback, the Better Auth origin check, and
// `assertTrustedMutationOrigin`. `AuthModule` is imported by `DomainsModule`
// (the domain controller authorizes like every other admin surface), so putting
// this in `DomainsModule` would make the module arrow circular and force a
// `forwardRef`. `CommonModule` is `@Global()` and imports nothing, so it is the
// only place the arrow points one way from.
//
// TWO SETS, AND THE DIFFERENCE MATTERS:
//
//   STATIC hosts come from configuration (APP_URL, API_URL, BETTER_AUTH_URL, the
//   CNAME target, plus loopback outside production). They are known at boot, are
//   never absent, and are answered SYNCHRONOUSLY — which is what lets the CORS
//   callback and the CSRF origin check keep working exactly as they did when
//   custom domains are off or the database is unreachable.
//
//   VERIFIED hosts come from `workspace_domains` and change while the process
//   runs. They are answered asynchronously (`isTrustedHost`) with a small
//   per-process cache, and synchronously (`isTrustedOriginSync`) only from what
//   that cache has already seen — a cache MISS is a "no", never a blocking read
//   on a request thread that has no `await` to give.
//
// FAIL-CLOSED. A database error resolves to "not trusted" rather than throwing:
// the caller is a middleware deciding whether to serve a request, and an
// exception there would turn a transient database blip into a 500 on the primary
// host, which is strictly worse than refusing an unverified tenant host.

import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { DatabaseService } from "../database/database.service";
import { workspaceDomains } from "../database/schema";

/**
 * ponytail: a per-process Map with a TTL, not Redis.
 *
 * The cache is a latency optimisation over a single indexed equality lookup, not
 * a correctness mechanism — every entry is re-read within a minute, and a stale
 * NEGATIVE (ten seconds) is what an administrator sees between finishing
 * verification and the host answering. With N API processes the worst case is
 * one extra query per host per process per minute, which is nothing.
 *
 * THE CEILING WORTH NAMING IS THE STALE POSITIVE, NOT THE STALE NEGATIVE.
 * `invalidate()` is process-local. On more than one replica, `DELETE /domain` or
 * a failed re-verification clears the cache only on the replica that handled the
 * call; every other replica keeps answering "trusted" for that hostname for up
 * to `POSITIVE_TTL_MS` (60 s). During that window the removed host still passes
 * `TrustedHostMiddleware`, still gets a CORS allow, and still satisfies
 * `assertTrustedMutationOrigin`. It is bounded, it is short, and it never grants
 * cross-workspace data access — the request still has to authenticate and
 * authorize — but a removal is not effective fleet-wide the instant it returns.
 *
 * Upgrade path: publish a `domain.verified` / `domain.removed` invalidation over
 * the Redis pub/sub the realtime adapter already runs on, have every replica
 * `invalidate()` on receipt, and drop the TTL to a plain invalidation-driven map.
 * Do that when the deployment first runs more than one API replica (Part 80).
 */
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

interface CacheEntry {
  readonly trusted: boolean;
  readonly expiresAt: number;
}

/** Lowercase, strip a trailing root dot and any `:port` the Host header carried. */
export function canonicalHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // An IPv6 literal is bracketed; only a port follows the closing bracket.
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const withoutPort = trimmed.includes(":") ? (trimmed.split(":")[0] ?? "") : trimmed;
  return withoutPort.replace(/\.$/u, "");
}

@Injectable()
export class VerifiedHostsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly staticHostSet: ReadonlySet<string>;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_CONFIG) authConfig: AuthConfig,
  ) {
    const hosts = new Set<string>([
      canonicalHost(config.appUrl.hostname),
      canonicalHost(config.apiUrl.hostname),
      canonicalHost(config.websocketUrl.hostname),
      canonicalHost(authConfig.baseUrl.hostname),
      canonicalHost(config.customDomainCnameTarget),
      ...authConfig.trustedOrigins.map((origin) => canonicalHost(new URL(origin).hostname)),
    ]);
    if (config.nodeEnv !== "production") {
      // Development and test reach the API on several loopback spellings — the
      // Docker publish address, `localhost`, and the IPv6 form — and none of
      // them is a tenant host anyone could claim. The IPv6 form is BRACKETED
      // only: `canonicalHost` folds a bare `::1` to `""` (everything before the
      // first colon is read as the host), so an unbracketed entry would be dead
      // weight that no lookup can ever match.
      for (const loopback of ["localhost", "127.0.0.1", "[::1]"]) hosts.add(loopback);
    }
    this.staticHostSet = hosts;
  }

  /** Configured hosts, answered without I/O. Never empty. */
  get staticHosts(): ReadonlySet<string> {
    return this.staticHostSet;
  }

  /**
   * Is this host allowed to reach the API? Static hosts always; verified tenant
   * hostnames only while the feature is enabled.
   */
  async isTrustedHost(host: string): Promise<boolean> {
    const hostname = canonicalHost(host);
    if (hostname === "") return false;
    if (this.staticHostSet.has(hostname)) return true;
    if (!this.config.customDomainsEnabled) return false;

    const cached = this.cache.get(hostname);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.trusted;

    let trusted = false;
    try {
      const [row] = await this.database.db
        .select({ id: workspaceDomains.id })
        .from(workspaceDomains)
        .where(
          and(eq(workspaceDomains.hostname, hostname), eq(workspaceDomains.status, "verified")),
        )
        .limit(1);
      trusted = row !== undefined;
    } catch {
      // Fail closed WITHOUT caching: a transient database fault must not pin a
      // real tenant host to "untrusted" for the next ten seconds.
      return false;
    }
    this.cache.set(hostname, {
      trusted,
      expiresAt: Date.now() + (trusted ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    return trusted;
  }

  /**
   * The synchronous answer for callers that have no `await` — the CORS origin
   * callback and the Better Auth CSRF pre-check.
   *
   * Static hosts always answer here. A verified tenant host answers only if the
   * cache already holds it, which it does for every host that has served a
   * request in the last minute — and the CSRF check on a custom host is always
   * preceded by the trusted-host middleware, which populates it.
   */
  isTrustedOriginSync(origin: string): boolean {
    let hostname: string;
    try {
      hostname = canonicalHost(new URL(origin).hostname);
    } catch {
      return false;
    }
    if (hostname === "") return false;
    if (this.staticHostSet.has(hostname)) return true;
    if (!this.config.customDomainsEnabled) return false;
    const cached = this.cache.get(hostname);
    return cached !== undefined && cached.expiresAt > Date.now() && cached.trusted;
  }

  /**
   * Every verified tenant origin, for Better Auth's async `trustedOrigins`.
   * Reads the table directly — this runs once per auth request, not per HTTP
   * request, and a stale answer there is a sign-in that fails on a host the
   * administrator just verified.
   *
   * ponytail: unbounded and uncached — one full scan of the verified rows per
   * auth request. `workspace_domains` holds at most one row per workspace, so at
   * current scale this is a few dozen rows off an index. Cache it behind the
   * same TTL as `isTrustedHost` (and invalidate it on the same events) once the
   * verified-domain count reaches the low thousands or auth traffic makes the
   * per-request scan visible.
   */
  async verifiedOriginsFor(protocol: "http" | "https" = "https"): Promise<readonly string[]> {
    if (!this.config.customDomainsEnabled) return [];
    try {
      const rows = await this.database.db
        .select({ hostname: workspaceDomains.hostname })
        .from(workspaceDomains)
        .where(eq(workspaceDomains.status, "verified"));
      return rows.map((row) => `${protocol}://${row.hostname}`);
    } catch {
      return [];
    }
  }

  /** Drop a host from the cache after a verification or a removal. */
  invalidate(host: string): void {
    this.cache.delete(canonicalHost(host));
  }
}
