/**
 * URL sanitisation for note documents: the one place that decides whether a
 * link may exist at all.
 *
 * Split out of `document.schema.ts`, which was 2 815 lines. This is a genuine
 * leaf — it imports nothing from the schema and nothing from the package — and
 * it is the file to read when the question is "can this href hurt anyone?"
 * rather than "is this document shaped correctly?".
 *
 * THE ALLOW-LIST IS THE DESIGN. Three schemes are permitted (`http`, `https`,
 * `mailto`, `tel`); everything else is rejected by absence, so `javascript:`,
 * `data:` and `vbscript:` need no special case. Percent-encoding is inspected
 * rather than decoded, because a decode gives the value a second chance to mean
 * something else in another layer.
 *
 * The colour, alignment and font-size constants that used to sit in the middle
 * of this block stayed behind: they are attribute values, not URLs, and both the
 * contract validator and the migrator need them.
 */

export const SAFE_LINK_REL = "noopener noreferrer nofollow";
const URL_MAX_LENGTH = 2_048;
const MAILTO_ADDRESS_MAX_LENGTH = 320;
const TEL_VALUE_MAX_LENGTH = 64;
const URL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
// Imported from `common.schema.ts`; see HEX_COLOR_PATTERN there.
const HTTP_HOST_LABEL_PATTERN = /^[a-z0-9-]+$/i;
const MAILBOX_LOCAL_PATTERN = /^[A-Za-z0-9.!#$&'*+/=?^_`{|}~-]+$/;
const TELEPHONE_PATTERN = /^\+?(?:\d|\(\d+\))(?:[\d .-]|\(\d+\))*$/;

function hexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function hasUnsafeUrlCharacter(value: string, rejectSpace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (rejectSpace && code === 0x20) ||
      code === 0x3c ||
      code === 0x3e ||
      code === 0x22 ||
      code === 0x5c
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafePercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x25) continue;
    if (index + 2 >= value.length) return true;
    const high = hexDigitValue(value.charCodeAt(index + 1));
    const low = hexDigitValue(value.charCodeAt(index + 2));
    if (high < 0 || low < 0) return true;
    const decoded = high * 16 + low;
    if (decoded <= 0x20 || decoded === 0x7f || decoded === 0x5c) return true;
    index += 2;
  }
  return false;
}

function rawHttpAuthority(value: string, schemeMatchLength: number): string | null {
  const remainder = value.slice(schemeMatchLength);
  if (!remainder.startsWith("//")) return null;
  const authorityStart = schemeMatchLength + 2;
  let authorityEnd = value.length;
  for (let index = authorityStart; index < value.length; index += 1) {
    const character = value[index];
    if (character === "/" || character === "?" || character === "#") {
      authorityEnd = index;
      break;
    }
  }
  const authority = value.slice(authorityStart, authorityEnd);
  return authority.length === 0 ? null : authority;
}

function isValidHttpHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  const labels = hostname.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      HTTP_HOST_LABEL_PATTERN.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

interface RuntimeUrl {
  readonly href: string;
  readonly hostname: string;
  readonly password: string;
  readonly protocol: string;
  readonly username: string;
}

/**
 * Declared, not probed. This file used to read `globalThis.URL ?? null` and
 * treat an absent global as "reject this link", which fails closed on an
 * ENVIRONMENT PROBE rather than on the input: in a runtime without `URL` every
 * http(s) href in every document became invalid, and `normalizeMarks` silently
 * dropped the link mark instead of saying why. It also made this package hold
 * three contradictory beliefs about one global — a probe here, a `declare` in
 * `domain.schema.ts`, and a comment in `webhook.schema.ts` asserting it does
 * not exist.
 *
 * `domain.schema.ts` has the right shape and its reasoning is written down
 * there: the package targets runtimes that all have `URL`, but its `tsconfig`
 * deliberately declares neither the DOM nor the Node type libraries, so one
 * structural declaration of exactly the members used is smaller than pulling in
 * `lib.dom`. A missing global is now a load-time failure, which is what an
 * unsupported runtime should look like.
 */
declare const URL: new (input: string) => RuntimeUrl;

function sanitizeHttpUrl(
  value: string,
  scheme: "http" | "https",
  schemeLength: number,
): string | null {
  if (hasUnsafeUrlCharacter(value, true) || hasUnsafePercentEncoding(value)) return null;
  const authority = rawHttpAuthority(value, schemeLength);
  if (authority === null || authority.includes("%") || authority.endsWith(":")) return null;

  let parsed: RuntimeUrl;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${scheme}:` ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    !isValidHttpHostname(parsed.hostname)
  ) {
    return null;
  }
  return parsed.href;
}

function sanitizeMailtoUrl(value: string, schemeLength: number): string | null {
  if (hasUnsafeUrlCharacter(value, false) || hasUnsafePercentEncoding(value)) return null;
  const address = value.slice(schemeLength);
  if (
    address.length === 0 ||
    address.length > MAILTO_ADDRESS_MAX_LENGTH ||
    address.startsWith("//") ||
    address.includes(":") ||
    address.includes("?") ||
    address.includes("#") ||
    address.includes("%")
  ) {
    return null;
  }
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    local.length > 64 ||
    !MAILBOX_LOCAL_PATTERN.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !isValidHttpHostname(domain)
  ) {
    return null;
  }
  return value;
}

function sanitizeTelephoneUrl(value: string, schemeLength: number): string | null {
  if (hasUnsafeUrlCharacter(value, false) || hasUnsafePercentEncoding(value)) return null;
  const telephone = value.slice(schemeLength);
  if (
    telephone.length === 0 ||
    telephone.length > TEL_VALUE_MAX_LENGTH ||
    telephone.startsWith("//") ||
    telephone.includes("@") ||
    telephone.includes("?") ||
    telephone.includes("#") ||
    telephone.includes("%") ||
    !TELEPHONE_PATTERN.test(telephone)
  ) {
    return null;
  }
  for (let index = 0; index < telephone.length; index += 1) {
    const code = telephone.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) return value;
  }
  return null;
}

/**
 * Return a trimmed, bounded URL when it matches the contract's conservative
 * http, https, mailto, or tel grammar. HTTP parsing uses the cross-runtime
 * WHATWG URL implementation and rejects credentials and deceptive authorities.
 */
export function sanitizeDocumentUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.length > URL_MAX_LENGTH) return null;

  const match = URL_SCHEME_PATTERN.exec(cleaned);
  const schemePart = match?.[1];
  const fullMatch = match?.[0];
  if (schemePart === undefined || fullMatch === undefined) return null;
  const scheme = schemePart.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return sanitizeHttpUrl(cleaned, scheme, fullMatch.length);
  }
  if (scheme === "mailto") return sanitizeMailtoUrl(cleaned, fullMatch.length);
  if (scheme === "tel") return sanitizeTelephoneUrl(cleaned, fullMatch.length);
  return null;
}
