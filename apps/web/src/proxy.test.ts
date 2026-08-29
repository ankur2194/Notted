// @vitest-environment node

/**
 * Part 73 — the I/O half of the custom-host entry point.
 *
 * `lib/domains/custom-host.test.ts` already pins the RULES; this file pins the
 * three things only the proxy can get wrong, and that a pure decision test can
 * never see:
 *
 *   - that the primary host costs NO network call, because this runs ahead of
 *     every request on every deployment, including the single-host ones;
 *   - that the resolve call goes to the deployment's own API and carries no
 *     caller credentials, because sending a tenant's cookies to a public route
 *     would be a needless disclosure;
 *   - that a resolve failure degrades to 404 rather than a 500, because a slow
 *     or down API must not take the tenant hostnames with it;
 *   - that a definitive answer, in EITHER direction, is remembered, because the
 *     memo is the only thing standing between a busy tenant hostname and one
 *     resolve round trip per page view.
 *
 * The memo is module state that outlives a test, so every case that counts
 * `fetch` calls uses its own hostname.
 *
 * A `node` environment on purpose: this module never runs in a browser, and the
 * default `jsdom` one would substitute its own `AbortSignal`/`Event` globals for
 * the runtime ones the proxy actually uses.
 */

import { DOMAIN_API_PATHS } from "@notted/shared-types";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real module reads `process.env` at import time, so a fixed stand-in is
// what lets the test tell "primary host" apart from "loopback" — under the
// development defaults both are `localhost:3000` and the distinction vanishes.
vi.mock("@/config/public-environment", () => ({
  publicEnvironment: {
    NEXT_PUBLIC_APP_URL: "https://app.notted.test",
    NEXT_PUBLIC_API_URL: "https://api.notted.test",
    NEXT_PUBLIC_WS_URL: "wss://api.notted.test",
  },
}));

import { config, PATHNAME_HEADER, proxy } from "./proxy";

import { WORKSPACE_SELECTION_COOKIE } from "@/lib/shell/constants";

const TENANT_HOST = "notes.acme.test";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";

function resolved(status = 200): Response {
  return new Response(JSON.stringify({ workspaceId: WORKSPACE_ID, slug: "acme" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RequestOptions {
  readonly host?: string;
  readonly forwardedHost?: string;
  readonly pathname?: string;
  readonly method?: string;
  readonly selectedWorkspaceId?: string;
}

function request(options: RequestOptions = {}): NextRequest {
  const host = options.forwardedHost ?? options.host ?? TENANT_HOST;
  const headers = new Headers();
  if (options.host !== undefined) headers.set("host", options.host);
  if (options.forwardedHost !== undefined) headers.set("x-forwarded-host", options.forwardedHost);
  if (options.host === undefined && options.forwardedHost === undefined) {
    headers.set("host", TENANT_HOST);
  }
  if (options.selectedWorkspaceId !== undefined) {
    headers.set("cookie", `${WORKSPACE_SELECTION_COOKIE}=${options.selectedWorkspaceId}`);
  }
  return new NextRequest(new URL(options.pathname ?? "/", `https://${host}`), {
    method: options.method ?? "GET",
    headers,
  });
}

/**
 * `NextResponse.next()` is not distinguishable from a plain 200 by status alone
 * — the `x-middleware-next` marker is the signal Next itself reads to mean "keep
 * routing this request".
 */
function isPassThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("custom-host proxy", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(resolved());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("passes the primary host through without resolving anything", async () => {
    const response = await proxy(request({ host: "app.notted.test" }));

    expect(isPassThrough(response)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stamps the requested pathname so a layout can read it", async () => {
    // The App Router hands a layout no pathname, so `(dashboard)/layout.tsx`
    // sent every unauthenticated visitor to `loginPathFor("/")` and lost the
    // page they asked for. Next carries an overridden request header on the
    // response as `x-middleware-request-<name>`.
    const response = await proxy(
      request({ host: "app.notted.test", pathname: "/workspaces/w/notes/n" }),
    );

    expect(isPassThrough(response)).toBe(true);
    expect(response.headers.get(`x-middleware-request-${PATHNAME_HEADER}`)).toBe(
      "/workspaces/w/notes/n",
    );
  });

  it("passes a loopback host through without resolving anything", async () => {
    const response = await proxy(request({ host: "localhost:3000" }));

    expect(isPassThrough(response)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host the API does not recognise, and remembers it", async () => {
    // Its own hostname: the memo is module state that outlives a test.
    const host = "unrecognised.acme.test";
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    expect((await proxy(request({ host }))).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The second request is refused from the memo — no round trip. This is what
    // stops a flood of bogus `Host` headers from costing one API call each.
    expect((await proxy(request({ host }))).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A resolve call that never answers must cost the tenant a 404, not an
  // unhandled rejection that Next reports as a 500.
  it("refuses the host when the resolve call fails instead of propagating", async () => {
    const host = "timing-out.acme.test";
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    expect((await proxy(request({ host }))).status).toBe(404);

    // NOT remembered: a transient API fault must not pin a real tenant host to
    // 404 for the next minute, so the next request tries again.
    expect((await proxy(request({ host }))).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pins the selection cookie to the workspace the host belongs to", async () => {
    const response = await proxy(request());

    expect(isPassThrough(response)).toBe(true);
    const cookie = response.cookies.get(WORKSPACE_SELECTION_COOKIE);
    expect(cookie?.value).toBe(WORKSPACE_ID);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
  });

  it("leaves the selection cookie alone when it already names this workspace", async () => {
    const response = await proxy(request({ selectedWorkspaceId: WORKSPACE_ID }));

    expect(isPassThrough(response)).toBe(true);
    expect(response.cookies.get(WORKSPACE_SELECTION_COOKIE)).toBeUndefined();
  });

  it("refuses a path naming a workspace other than the host's", async () => {
    const response = await proxy(request({ pathname: `/workspaces/${OTHER_WORKSPACE_ID}` }));

    expect(response.status).toBe(404);
  });

  it("refuses the workspace-switch endpoint on a tenant host", async () => {
    const response = await proxy(request({ pathname: "/api/shell/workspace", method: "POST" }));

    expect(response.status).toBe(404);
  });

  // Behind the reverse proxy the `host` header is the internal upstream name;
  // only `x-forwarded-host` carries the name the visitor typed.
  it("prefers x-forwarded-host over host", async () => {
    const host = "forwarded.acme.test";
    const response = await proxy(request({ host: "web:3000", forwardedHost: host }));

    expect(isPassThrough(response)).toBe(true);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("host")).toBe(host);
  });

  it("resolves against the deployment's own API and sends no credentials", async () => {
    const host = "credentials.acme.test";
    await proxy(request({ host }));

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.notted.test");
    expect(url.pathname).toBe(DOMAIN_API_PATHS.resolve);
    expect(url.searchParams.get("host")).toBe(host);
    expect(init?.credentials).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });

  it("remembers a host the API resolved, and still decides per request", async () => {
    const host = "memoized.acme.test";

    expect(isPassThrough(await proxy(request({ host })))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second request on the same host: served from the memo, no round trip.
    expect(isPassThrough(await proxy(request({ host })))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The DECISION is not memoized — only the resolve outcome. A path naming
    // another workspace is still refused on the memo hit.
    const response = await proxy(request({ host, pathname: `/workspaces/${OTHER_WORKSPACE_ID}` }));
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("proxy matcher", () => {
  // Every excluded path would otherwise pay a resolve lookup, once per asset on
  // every page — the exclusion is the difference between one call a minute and
  // one per image.
  it("skips static assets and the well-known root files", () => {
    expect(config.matcher).toHaveLength(1);
    const pattern = new RegExp(`^${config.matcher[0]!}$`, "u");

    expect(pattern.test("/workspaces/abc")).toBe(true);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
    expect(pattern.test("/_next/image?url=%2Flogo.png")).toBe(false);
    expect(pattern.test("/favicon.ico")).toBe(false);
    expect(pattern.test("/robots.txt")).toBe(false);
  });
});
