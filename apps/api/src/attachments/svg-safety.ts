// Part 41: SVG prescan.
//
// STRATEGY: RASTERIZE, DO NOT SANITIZE-AND-SERVE. ADR 0005 permits either, and
// rasterization wins for three reasons:
//   1. A correct sanitizer needs a real DOM allow-list, which means dragging
//      `dompurify` + `jsdom` into the API for one upload path.
//      Rasterization needs no new dependency at all — librsvg is already inside
//      the libvips that Sharp ships.
//   2. Sanitizer bypasses are a permanent CVE treadmill (mXSS, namespace
//      confusion, mutation on re-serialization). A raster has no bypass class.
//   3. Every servable variant becomes png/webp, so the Part 40 download route
//      can never emit `image/svg+xml` and no browser ever parses attacker XML.
//
// This prescan is therefore DEFENCE IN DEPTH, not the control. It runs before
// librsvg sees the bytes and rejects the classes that hurt the SERVER rather
// than the browser: SSRF and local-file reads through external references,
// entity expansion (billion laughs / XXE), and `<foreignObject>`, which asks a
// renderer to process arbitrary foreign markup.
//
// REGEX SAFETY IS A REQUIREMENT, NOT A STYLE POINT. Every pattern below is
// linear: no nested quantifier, no alternation inside a repetition, no
// backreference. A `svg-safety.test.ts` case feeds a pathological input and
// asserts a wall-clock budget, because a prescan that can be made to backtrack
// is itself the denial of service it was added to prevent.
//
// Deliberate loss recorded in the completion record: rasterization discards
// vector scalability, so a rasterized logo will not stay crisp when scaled past
// its `full` rendition. Sanitize-and-serve can be revisited in Part 44.

/** Why a source was refused. Persisted only as the short `unsafe_svg` code. */
export type SvgRejectionReason =
  | "too_large"
  | "script_element"
  | "event_handler"
  | "foreign_object"
  | "entity_declaration"
  | "external_reference"
  | "not_svg";

export type SvgScanResult =
  { readonly safe: true } | { readonly safe: false; readonly reason: SvgRejectionReason };

const SAFE: SvgScanResult = Object.freeze({ safe: true });

function refuse(reason: SvgRejectionReason): SvgScanResult {
  return Object.freeze({ safe: false, reason });
}

// --- Element gates. Each is a literal-prefixed, bounded probe. ---
// The optional `prefix:` group matches a namespace-qualified spelling such as
// `<svg:script>` or `<s:foreignObject>`. XML lets a document bind the SVG
// namespace to any prefix, so the unprefixed form alone did not cover what this
// file claims to cover. The quantifier stays bounded ({1,32} over a character
// class that excludes `:`) so the scan cannot be made to backtrack.
const NS_PREFIX = "(?:[a-z0-9_-]{1,32}:)?";
const SCRIPT_ELEMENT = new RegExp(`<\\s*${NS_PREFIX}script[\\s/>]`, "iu");
const FOREIGN_OBJECT = new RegExp(`<\\s*${NS_PREFIX}foreignobject[\\s/>]`, "iu");
// Catches `<!ENTITY …>` directly and inside a DOCTYPE internal subset. `\s` is
// bounded by `*` over a character class, which cannot backtrack pathologically.
const ENTITY_DECLARATION = /<!\s*ENTITY\b/iu;
// A DOCTYPE internal subset is the only place an entity can be declared, so its
// opening bracket is refused even when no `<!ENTITY` follows in the scanned
// window.
const DOCTYPE_INTERNAL_SUBSET = /<!\s*DOCTYPE[^[<>]{0,256}\[/iu;
// Prefixed for the same reason as the gates above: `<svg:svg xmlns:svg="…">` is
// a legitimate spelling, and refusing it as `not_svg` would reject a valid file.
const ROOT_ELEMENT = new RegExp(`<\\s*${NS_PREFIX}svg[\\s/>]`, "iu");

/**
 * Inline event handlers (`onload`, `onclick`, …).
 *
 * Inert on this path — the SVG is rasterized by librsvg, which never executes
 * script, and no variant is ever served as `image/svg+xml`. It is refused
 * anyway so the scan's answer does not depend on which of those two facts is
 * still true later, and so this file cannot be quietly repurposed as a
 * "safe to serve as SVG" gate, which it is not. The name is bounded to 20
 * characters over a class with no overlap with `\s`.
 */
const EVENT_HANDLER_ATTRIBUTE = /\son[a-z]{1,20}\s*=/iu;

/**
 * Every `href` / `xlink:href` value, in one linear pass. Each alternative body
 * is a simple negated character class, so the engine never re-enters a group.
 */
const HREF_ATTRIBUTE = /\b(?:xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/giu;

/** Bounds the linear pass so a source packed with attributes still terminates. */
const MAX_HREF_MATCHES = 512;

/**
 * The only external-looking references a rasterized SVG may carry. Fragment
 * references stay inside the document; the two raster data URIs are inert bytes
 * librsvg decodes itself with no network or filesystem access.
 */
const ALLOWED_DATA_URI_PREFIXES = Object.freeze([
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
] as const);

function isAllowedReference(rawValue: string): boolean {
  const value = rawValue.trim();
  if (value === "") return true;
  // Same-document reference (`<use href="#icon">`, gradients, clip paths).
  if (value.startsWith("#")) return true;
  const lowered = value.toLowerCase();
  return ALLOWED_DATA_URI_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/**
 * Reject an SVG the server should not hand to a rasterizer.
 *
 * `maximumBytes` is checked FIRST and on the raw buffer, so a hostile source can
 * never make the scanner do work proportional to its own size beyond that cap.
 * The reference policy is deliberately stricter than "no `http:`": ANY reference
 * that is not a document fragment or an inline PNG/JPEG data URI is refused,
 * including relative paths and `file:`. Rasterization ignores hyperlinks
 * entirely, so nothing legitimate is lost by refusing them, and the rule has no
 * gap for a scheme nobody thought of.
 */
export function scanSvgSource(source: Buffer, maximumBytes: number): SvgScanResult {
  if (source.byteLength > maximumBytes) return refuse("too_large");

  const text = source.toString("utf8");

  if (ENTITY_DECLARATION.test(text)) return refuse("entity_declaration");
  if (DOCTYPE_INTERNAL_SUBSET.test(text)) return refuse("entity_declaration");
  if (SCRIPT_ELEMENT.test(text)) return refuse("script_element");
  if (EVENT_HANDLER_ATTRIBUTE.test(text)) return refuse("event_handler");
  if (FOREIGN_OBJECT.test(text)) return refuse("foreign_object");
  if (!ROOT_ELEMENT.test(text)) return refuse("not_svg");

  HREF_ATTRIBUTE.lastIndex = 0;
  for (let seen = 0; seen < MAX_HREF_MATCHES; seen += 1) {
    const match = HREF_ATTRIBUTE.exec(text);
    if (match === null) return SAFE;
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!isAllowedReference(value)) {
      HREF_ATTRIBUTE.lastIndex = 0;
      return refuse("external_reference");
    }
  }
  // More references than the bound allows is itself suspicious; refuse rather
  // than silently stop checking.
  HREF_ATTRIBUTE.lastIndex = 0;
  return refuse("external_reference");
}
