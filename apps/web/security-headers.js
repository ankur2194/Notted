// Security response headers, wired into next.config.js's `headers()`. Kept as
// a CJS file at the apps/web root (not under src/) because next.config.js is
// CJS and must `require()` it directly, before any TypeScript build step runs.

/**
 * Returns a URL's origin, or null when the input is missing or malformed. A
 * bad env value must not fail the build — the affected CSP source is simply
 * omitted rather than the whole config throwing.
 * @param {string | undefined} url
 * @returns {string | null}
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * @param {{ apiUrl?: string; wsUrl?: string; production: boolean }} options
 * @returns {{ key: string; value: string }[]}
 */
function buildSecurityHeaders({ apiUrl, wsUrl, production }) {
  const apiOrigin = safeOrigin(apiUrl);
  const wsOrigin = safeOrigin(wsUrl);

  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (!production) {
    scriptSrc.push("'unsafe-eval'");
  }

  const connectSrc = ["'self'", ...(apiOrigin ? [apiOrigin] : []), ...(wsOrigin ? [wsOrigin] : [])];
  if (!production) {
    connectSrc.push("ws:", "wss:");
  }

  const csp = [
    "default-src 'self'",
    // 'unsafe-inline' is REQUIRED: Next 16 App Router emits inline flight/
    // bootstrap scripts and there is no nonce seam without a proxy rewrite.
    // Tracked as exception E1 in docs/security/remediation-checklist.md,
    // closed at Part 82.
    // ponytail: no script nonce, close via the Part 82 proxy rewrite.
    `script-src ${scriptSrc.join(" ")}`,
    // 'unsafe-inline' is required by Tailwind/Next inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    // Part 72 renders the workspace logo as an <img> from the API origin,
    // which is why the API origin is named here.
    `img-src 'self' data: blob:${apiOrigin ? ` ${apiOrigin}` : ""}`,
    "font-src 'self' data:",
    // Part 73 custom hosts serve the API same-origin, so 'self' already
    // covers them; the explicit origins below cover split-origin development
    // and the default topology.
    `connect-src ${connectSrc.join(" ")}`,
    // blob: (here and in img-src above) is required by the pdf.js worker and
    // client-side image previews.
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const headers = [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    { key: "X-Frame-Options", value: "DENY" },
  ];

  if (production) {
    // Never sent in development: it would pin the developer's browser to
    // HTTPS for localhost and break every other local project on that host.
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  }

  return headers;
}

module.exports = { buildSecurityHeaders };
