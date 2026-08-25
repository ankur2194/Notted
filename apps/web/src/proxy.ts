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
// A host the API DEFINITIVELY refused is remembered for 60 s in a bounded map,
// so a flood of bogus `Host` headers does not buy a round trip per request. A
// host the API merely failed to answer for is NOT remembered — see
// `ResolveOutcome` below. The `next: { revalidate }` hint is left on the fetch
// for the day the proxy runtime honours it; today it does not.

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
 * ponytail: a bounded per-process Map, not a shared cache.
 *
 * `next: { revalidate }` does nothing in the proxy runtime — the Next data
 * cache is not available here — so without this every request on an unknown
 * hostname is its own `resolve` round trip, which is what makes a bogus-Host
 * flood cheap for the sender and expensive for us. 500 entries at ~60 bytes
 * each is negligible, and eviction is oldest-first because a `Map` already
 * keeps insertion order and an LRU would need a second structure.
 *
 * The ceiling: it is per process, so N instances each pay their own first miss,
 * and a hostname verified during the window still 404s for up to 60 s on the
 * instances that saw it before. Upgrade path is the same as the API's
 * `VerifiedHostsService`: a Redis pub/sub invalidation on `domain.verified`.
 */
const UNKNOWN_HOST_MEMO_MS = 60_000;
const UNKNOWN_HOST_MEMO_MAX = 500;
const unknownHosts = new Map<string, number>();

function isKnownUnknown(host: string): boolean {
  const until = unknownHosts.get(host);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  unknownHosts.delete(host);
  return false;
}

function rememberUnknown(host: string): void {
  if (unknownHosts.size >= UNKNOWN_HOST_MEMO_MAX) {
    const oldest = unknownHosts.keys().next().value;
    if (oldest !== undefined) unknownHosts.delete(oldest);
  }
  unknownHosts.set(host, Date.now() + UNKNOWN_HOST_MEMO_MS);
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

  // A host the API already refused inside the memo window costs no round trip.
  if (isKnownUnknown(host)) return notFound();

  // THERE IS NO SEPARATE WEB-SIDE FEATURE FLAG. The API's `CUSTOM_DOMAINS_ENABLED`
  // is the one switch: with it off, `resolve` answers 404 for every host, so this
  // call already refuses every non-primary hostname. A second flag here could
  // only ever disagree with the first.
  const outcome = await resolveHost(host);
  if (outcome === "unknown") {
    rememberUnknown(host);
    return notFound();
  }

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
