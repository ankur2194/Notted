import { publicEnvironment } from "@/config/public-environment";

/**
 * Where the API and the realtime socket live, as seen by the caller.
 *
 * ONE module so there is ONE answer, and — since Part 73 — one answer that can
 * differ between the server and the browser.
 *
 * THE PROBLEM. `NEXT_PUBLIC_*` values are inlined into the bundle AT BUILD TIME.
 * A custom-domain deployment serves the same bundle on the primary host and on
 * every tenant hostname, so a browser on `notes.acme.com` would otherwise be
 * told to call `https://api.notted.example` — a cross-origin request whose
 * session cookie is host-only and therefore is not attached. The user would be
 * signed in to a page that cannot read anything.
 *
 * THE RULE. In the BROWSER, when the page's own host is not the configured
 * primary app host, the API and the socket are addressed on the page's own
 * origin — which is exactly the same-origin topology Part 73 requires the
 * reverse proxy to provide (`/api/*` and `/socket.io/*` on the tenant host).
 * Everywhere else — the server, and the primary host — the configured values are
 * used unchanged, so nothing about the existing single-host deployment moves.
 *
 * SERVER CODE MUST NOT CALL THESE. A Server Component has no `window`, and its
 * fetch goes to the API over the internal network, not through the tenant's
 * edge. The `server-*.ts` modules under `lib/` and the route handlers
 * deliberately keep reading `publicEnvironment` directly.
 */

/** `true` only in a browser that is being served on a non-primary host. */
function onCustomHost(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.location.host !== new URL(publicEnvironment.NEXT_PUBLIC_APP_URL).host;
  } catch {
    return false;
  }
}

/** The build-time API origin — what the server (and a primary-host browser) uses. */
export function primaryApiOrigin(): string {
  return new URL(publicEnvironment.NEXT_PUBLIC_API_URL).origin;
}

export function apiOrigin(): string {
  if (onCustomHost()) return window.location.origin;
  return primaryApiOrigin();
}

/**
 * Where the Socket.io client connects. The same rule as {@link apiOrigin}, with
 * the scheme mapped to the page's: a `wss://` value hard-coded at build time
 * would be wrong on a tenant host served over plain `http` in development, and a
 * `ws://` one would be blocked as mixed content on a tenant host served over TLS.
 */
export function wsOrigin(): string {
  if (onCustomHost()) {
    return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  }
  return new URL(publicEnvironment.NEXT_PUBLIC_WS_URL).origin;
}

/**
 * Absolute URL for an asset the API serves, from the app-relative path the API
 * itself persisted (a workspace `logoUrl`, for example).
 *
 * ONLY an app-relative `/…` path resolves. An absolute URL, a protocol-relative
 * `//host` value, a `javascript:` or `data:` scheme, or an empty string yields
 * `null` — this function's inputs come out of the database and land in an
 * `<img src>`, so it must not be able to point one at somewhere else. Callers
 * render their own fallback (initials, the Notted mark) on `null`.
 *
 * `origin` defaults to {@link apiOrigin}; a component that renders on the server
 * passes {@link primaryApiOrigin} as its hydration snapshot so the HTML and the
 * first client render agree on a custom host.
 */
export function apiAssetUrl(
  path: string | null | undefined,
  origin: string = apiOrigin(),
): string | null {
  if (typeof path !== "string") return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  try {
    return new URL(path, origin).toString();
  } catch {
    return null;
  }
}
