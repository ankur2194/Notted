// Part 73 — the web app's custom-host entry point (Next 16 `proxy` convention,
// the successor to `middleware.ts`).
//
// WHAT RUNS HERE AND WHAT DOES NOT. This decides whether a request arriving on a
// non-primary hostname may render at all, and which workspace the shell should
// open. It is NOT an authorization boundary: every API route re-authorizes
// workspace membership server-side, and nothing here can be trusted to keep a
// member out of data they are entitled to. What it prevents is INCOHERENCE — a
// tenant's branded hostname rendering another tenant's workspace under that
// tenant's certificate — and an unverified hostname rendering anything at all.
//
// The decision itself is pure and lives in `lib/domains/custom-host.ts`; this
// file only performs the I/O it needs.
//
// THE RESOLVE CALL IS SERVER-SIDE AND BOUNDED. It runs on the deployment's own
// network against `NEXT_PUBLIC_API_URL` (never the tenant's edge) and carries a
// 3-second abort. A failed or slow call resolves to "unknown host" — a 404 —
// because rendering a hostname we cannot currently confirm is the failure mode
// this whole part exists to avoid.
//
// A host the API DEFINITIVELY answered for — refused OR resolved — is remembered
// for 60 s in a bounded map, so neither a flood of bogus `Host` headers nor a
// busy tenant buys a round trip per request. A host the API merely failed to
// answer for is NOT remembered — see `ResolveOutcome` below. The
// `next: { revalidate }` hint is left on the fetch for the day the proxy runtime
// honours it; today it does not.

import { DOMAIN_API_PATHS } from "@notted/shared-types";
import { NextResponse, type NextRequest } from "next/server";

import { publicEnvironment } from "@/config/public-environment";
import { decideCustomHostRoute, type ResolvedCustomHost } from "@/lib/domains/custom-host";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/shell/constants";

const RESOLVE_TIMEOUT_MS = 3_000;
const RESOLVE_CACHE_SECONDS = 60;

/**
 * `"unknown"` = the API answered and said no. `"unavailable"` = it did not
 * answer usefully. Both end in a 404, but only the first is safe to remember:
 * pinning a real tenant host to 404 because the API blipped is exactly the
 * failure this file is meant to avoid.
 */
type ResolveOutcome = ResolvedCustomHost | "unknown" | "unavailable";

/**
 * The two outcomes the API answered definitively, and therefore the two that
 * are safe to remember. `"unavailable"` is deliberately absent from the union.
 */
type MemoizedOutcome = ResolvedCustomHost | "unknown";

/**
 * ponytail: a bounded per-process Map, not a shared cache.
 *
 * `next: { revalidate }` does nothing in the proxy runtime — the Next data
 * cache is not available here — so without this EVERY request on a non-primary
 * hostname is its own `resolve` round trip: one per bogus `Host` header, and
 * one per page view on a real tenant domain. 500 entries at ~120 bytes each is
 * negligible, and eviction is oldest-first because a `Map` already keeps
 * insertion order and an LRU would need a second structure.
 *
 * Only the resolve OUTCOME is memoized, never the decision — that also depends
 * on the request path and the selection cookie, so it is recomputed every time.
 *
 * The ceiling: it is per process, so N instances each pay their own first miss;
 * a hostname verified during the window still 404s for up to 60 s on instances
 * that saw it before; and a domain transferred between workspaces serves the
 * previous workspace's SHELL for up to 60 s — every API route still
 * re-authorizes, `VerifiedHostsService` still refuses at the data layer, and the
 * selection cookie is host-only, so it is incoherence for less than a minute,
 * not a data leak, and shorter than the DNS and certificate latency a real
 * transfer needs anyway. Upgrade path is the same as the API's
 * `VerifiedHostsService`: a Redis pub/sub invalidation on `domain.verified`.
 */
const HOST_MEMO_MS = 60_000;
const HOST_MEMO_MAX = 500;
const hostMemo = new Map<string, { readonly until: number; readonly outcome: MemoizedOutcome }>();

function readMemo(host: string): MemoizedOutcome | undefined {
  const entry = hostMemo.get(host);
  if (entry === undefined) return undefined;
  if (entry.until > Date.now()) return entry.outcome;
  hostMemo.delete(host);
  return undefined;
}

function rememberOutcome(host: string, outcome: MemoizedOutcome): void {
  if (hostMemo.size >= HOST_MEMO_MAX) {
    const oldest = hostMemo.keys().next().value;
    if (oldest !== undefined) hostMemo.delete(oldest);
  }
  hostMemo.set(host, { until: Date.now() + HOST_MEMO_MS, outcome });
}

async function resolveHost(host: string): Promise<ResolveOutcome> {
  try {
    const url = new URL(DOMAIN_API_PATHS.resolve, publicEnvironment.NEXT_PUBLIC_API_URL);
    url.searchParams.set("host", host);
    const response = await fetch(url, {
      // No credentials: this route is public by design, and forwarding a
      // tenant's cookies to it would be a needless disclosure.
      next: { revalidate: RESOLVE_CACHE_SECONDS },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    // 404 is the API's definitive "no such verified host"; any other non-2xx is
    // the API being unwell.
    if (response.status === 404) return "unknown";
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return "unavailable";
    const { workspaceId, slug } = body as Record<string, unknown>;
    if (typeof workspaceId !== "string" || typeof slug !== "string") return "unavailable";
    return { workspaceId, slug };
  } catch {
    return "unavailable";
  }
}

function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // `x-forwarded-host` is what a reverse proxy sets; `host` is what a direct
  // connection carries. Neither is authenticated here, and neither needs to be:
  // a forged value can only ever get a 404 or a workspace the caller must still
  // authorize against for every byte of data.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const primaryHost = new URL(publicEnvironment.NEXT_PUBLIC_APP_URL).host;
  const pathname = request.nextUrl.pathname;

  // The primary host is answered without any I/O at all, which is every request
  // on a deployment that serves one hostname.
  const shared = { host, primaryHost, pathname, method: request.method, enabled: true } as const;
  if (
    decideCustomHostRoute({ ...shared, resolved: null, selectedWorkspaceId: null }).kind ===
    "primary"
  ) {
    return NextResponse.next();
  }

  // THERE IS NO SEPARATE WEB-SIDE FEATURE FLAG. The API's `CUSTOM_DOMAINS_ENABLED`
  // is the one switch: with it off, `resolve` answers 404 for every host, so this
  // call already refuses every non-primary hostname. A second flag here could
  // only ever disagree with the first.
  //
  // A host the API already answered for inside the memo window costs no round
  // trip, in either direction.
  const memoized = readMemo(host);
  const outcome = memoized ?? (await resolveHost(host));
  if (memoized === undefined && outcome !== "unavailable") rememberOutcome(host, outcome);
  if (outcome === "unknown") return notFound();

  const decision = decideCustomHostRoute({
    ...shared,
    resolved: outcome === "unavailable" ? null : outcome,
    selectedWorkspaceId: request.cookies.get(WORKSPACE_SELECTION_COOKIE)?.value ?? null,
  });
  if (decision.kind !== "allow") return notFound();

  const response = NextResponse.next();
  if (decision.setWorkspaceCookie !== null) {
    // Host-only, like every cookie in this product: a custom host's selection
    // must not travel to the primary host or to another tenant's host.
    response.cookies.set(WORKSPACE_SELECTION_COOKIE, decision.setWorkspaceCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
    });
  }
  return response;
}

export const config = {
  // Static assets and the favicon never need a host decision, and paying a
  // resolve lookup for each one would multiply the cost by every image on a page.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
