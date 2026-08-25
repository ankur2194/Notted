import { z } from "zod";

import { isoTimestampSchema, uuidSchema } from "./common.schema";

/**
 * Part 73 — custom-domain contracts.
 *
 * ONE normalisation, shared by the browser, the API, the verifier, and the
 * trusted-host lookup. A hostname that is normalised differently on either side
 * of the wire is a hostname that verifies on one host and 404s on the other, and
 * `workspace_domains.hostname` is globally unique, so a second spelling is also
 * a second row that should have collided with the first.
 */

/**
 * `URL` is a global in every runtime this package targets (Node ≥ 10, every
 * browser, every bundler), but this package's `tsconfig` deliberately declares
 * neither the DOM nor the Node type libraries — it is framework-free by design,
 * and pulling in `lib.dom` to type one constructor would hand every schema in
 * here a `document` it must never touch. One structural declaration of exactly
 * the member used is smaller than that, and it emits nothing.
 */
declare const URL: new (input: string) => { readonly hostname: string };

/** One DNS label: 1–63 chars, alphanumeric, internal hyphens only. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`, "u");

/**
 * Suffixes that never leave the local network. A workspace that "verified"
 * `notes.local` would have verified nothing — the TXT lookup would resolve
 * through mDNS or a split-horizon resolver that answers differently for every
 * client, so the proof is not a proof.
 */
const RESERVED_SUFFIXES = [".local", ".internal", ".localhost", ".test", ".invalid", ".home.arpa"];
const RESERVED_HOSTS = new Set(["localhost"]);

/**
 * Fold a user-typed hostname into its canonical, storable form, or `null` when
 * it is not a hostname this platform will ever serve.
 *
 * `new URL("http://" + value).hostname` is the whole normaliser: it lowercases,
 * applies IDNA/punycode (`münchen.example` → `xn--mnchen-3ya.example`), and
 * rejects the byte sequences a hand-written regex gets wrong. Everything around
 * it is refusal, not transformation:
 *
 * - Any URL punctuation (`/ : @ ? # \` or whitespace) is refused BEFORE parsing.
 *   `new URL("http://notes.acme.com/private")` parses happily and yields the
 *   bare hostname, so accepting the input would silently discard the part of it
 *   that made it wrong.
 * - A trailing root dot is stripped first (`acme.com.` and `acme.com` are the
 *   same name and must not become two rows).
 * - IP literals, single labels, reserved suffixes, and wildcards are refused:
 *   none of them can carry a CNAME to this platform.
 */
export function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 254) return null;
  if (/[/\\:@?#\s]|%/u.test(trimmed)) return null;
  const withoutRootDot = trimmed.replace(/\.$/u, "");
  if (withoutRootDot === "") return null;

  let hostname: string;
  try {
    hostname = new URL(`http://${withoutRootDot}`).hostname;
  } catch {
    return null;
  }
  // `new URL` brackets an IPv6 literal and leaves an IPv4 literal alone; both
  // fail the label pattern below, but the bracket check keeps the intent local.
  if (hostname.startsWith("[")) return null;
  if (hostname.length > 253) return null;
  if (!HOSTNAME_PATTERN.test(hostname)) return null;
  if (/^\d+(?:\.\d+){3}$/u.test(hostname)) return null;
  if (RESERVED_HOSTS.has(hostname)) return null;
  if (RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
  return hostname;
}

/** The wire contract for a hostname a workspace claims. Normalised on parse. */
export const customDomainHostnameSchema = z
  .string()
  .max(254)
  .transform((value, context) => {
    const normalized = normalizeHostname(value);
    if (normalized === null) {
      context.addIssue({
        code: "custom",
        message:
          "Enter a public domain name such as notes.example.com — no protocol, path, port, or wildcard.",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const workspaceDomainStatusSchema = z.enum(["pending", "verified", "error"]);

/**
 * Why a verification FAILED, as a fixed vocabulary rather than a message.
 *
 * The API stores this in `workspace_domains.last_error` and the browser renders
 * the plain-English remedy. A resolver's own error text would be a third-party
 * string in a tenant-readable column, and it changes with the resolver.
 */
export const workspaceDomainErrorSchema = z.enum([
  "txt_missing",
  "txt_mismatch",
  "cname_mismatch",
  "dns_failure",
]);

export const workspaceDomainSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema,
  hostname: z.string().max(253),
  status: workspaceDomainStatusSchema,
  lastError: workspaceDomainErrorSchema.nullable(),
  lastCheckedAt: isoTimestampSchema.nullable(),
  verifiedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  /**
   * The two DNS records the administrator has to publish, rendered by the API
   * so the browser never has to know the token format or the CNAME target.
   */
  verificationRecord: z.object({
    name: z.string(),
    type: z.literal("TXT"),
    value: z.string(),
  }),
  cnameRecord: z.object({
    name: z.string(),
    type: z.literal("CNAME"),
    value: z.string(),
  }),
});

/** `GET`/`PUT`/`POST verify`/`DELETE` all answer with the same shape. */
export const workspaceDomainResultSchema = z.object({ domain: workspaceDomainSchema.nullable() });

export const setWorkspaceDomainSchema = z.object({ hostname: customDomainHostnameSchema }).strict();
export type SetWorkspaceDomainInput = z.input<typeof setWorkspaceDomainSchema>;

/**
 * The ACME / on-demand-TLS seam. The value is whatever a reverse proxy passed
 * through from the TLS handshake, so it is normalised here exactly like an
 * administrator's typed value — an issuer asking about `Notes.ACME.com` must get
 * the same answer as the browser asking about `notes.acme.com`.
 *
 * BOTH `?host=` and `?domain=` are accepted, and that is not indecision: Caddy's
 * `on_demand_tls ask` appends `?domain=<name>` and offers no way to rename it,
 * while every other caller (the web proxy, curl in the runbook) naturally says
 * `host`. Supporting one spelling would mean either an awkward alias route or a
 * documented "and Caddy needs a rewrite", both larger than one `??`.
 */
export const domainResolveQuerySchema = z
  .object({
    host: customDomainHostnameSchema.optional(),
    domain: customDomainHostnameSchema.optional(),
  })
  .strict()
  .transform((value, context) => {
    const host = value.host ?? value.domain;
    if (host === undefined) {
      context.addIssue({ code: "custom", message: "host is required" });
      return z.NEVER;
    }
    return { host };
  });
export type DomainResolveQueryInput = z.input<typeof domainResolveQuerySchema>;

/**
 * Identifiers only. This route is PUBLIC (a certificate issuer has no session),
 * so it answers "is this host one of ours, and whose" and nothing else — no
 * name, no plan, no member count.
 */
export const domainResolveResultSchema = z.object({
  workspaceId: uuidSchema,
  slug: z.string(),
});
