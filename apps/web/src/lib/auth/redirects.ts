const AUTH_PATHS = new Set([
  "/forgot-password",
  "/login",
  "/magic-link",
  "/register",
  "/reset-password",
  "/two-factor",
  "/verify-email",
]);

// eslint-disable-next-line no-control-regex -- security-positive: explicitly rejects C0 control chars and DEL so they cannot bypass downstream URL/path handling
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function isAuthPath(pathname: string): boolean {
  return [...AUTH_PATHS].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Accepts only an application-local absolute path. Percent escapes are rejected
 * rather than decoded so encoded slash, backslash, scheme and control-character
 * bypasses cannot acquire a second interpretation in another layer.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/"): string {
  if (
    value === null ||
    value === undefined ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("%") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, "https://notted.invalid");
  } catch {
    return fallback;
  }

  if (parsed.origin !== "https://notted.invalid" || isAuthPath(parsed.pathname)) {
    return fallback;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function loginPathFor(returnPath: string): string {
  const target = safeRedirectPath(returnPath);
  return target === "/" ? "/login?redirect=%2F" : `/login?redirect=${encodeURIComponent(target)}`;
}

export function readRedirectParam(
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const value = searchParams.redirect;
  return safeRedirectPath(Array.isArray(value) ? value[0] : value);
}
