// Part 73 — proving a workspace controls a hostname.
//
// TWO RECORDS, AND BOTH ARE REQUIRED.
//
//   1. TXT `_notted-verify.<host>` = `notted-verify=<token>` proves CONTROL OF
//      DNS for the name. Without it, anyone could point a CNAME at us and claim
//      a hostname they merely aim at us — the CNAME direction is chosen by the
//      claimant, so on its own it proves nothing about ownership.
//   2. CNAME `<host>` → `CUSTOM_DOMAIN_CNAME_TARGET` proves the name is actually
//      DELEGATED to this deployment. Without it, a workspace could "verify" a
//      hostname that resolves somewhere else entirely and hold the claim on a
//      globally-unique column forever, denying it to its real owner.
//
// The apex fallback exists because a zone apex cannot legally carry a CNAME
// (RFC 1034 §3.6.2). An apex that uses ALIAS/ANAME records at its provider
// resolves to the same addresses as the target, so the fallback compares the
// resolved address SETS: every address the host resolves to must also be an
// address the target resolves to. That is stricter than "any overlap", and it
// is the strongest statement address records can make.
//
// EVERY LOOKUP IS BOUNDED. A resolver that hangs would otherwise hold an HTTP
// request open for the platform default (which can be tens of seconds), and this
// runs on the request thread of an admin-triggered verify.

import { promises as dns } from "node:dns";

import type { WorkspaceDomainError } from "@notted/shared-types";

/** The DNS label the ownership token is published under. */
export const VERIFICATION_TXT_PREFIX = "_notted-verify";
/** The `key=value` shape of the TXT record's value. */
export const VERIFICATION_TXT_KEY = "notted-verify";

/**
 * Per-lookup ceiling. Five seconds is well past a healthy resolver's answer and
 * well short of an admin deciding the page is broken.
 */
export const DNS_TIMEOUT_MS = 5_000;

/** Injectable so the verifier's tests need no network and no fake resolver. */
export interface DomainDnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
  lookup(hostname: string): Promise<readonly { address: string }[]>;
}

export const defaultDomainDnsResolver: DomainDnsResolver = {
  resolveTxt: (hostname) => dns.resolveTxt(hostname),
  resolveCname: (hostname) => dns.resolveCname(hostname),
  lookup: async (hostname) => dns.lookup(hostname, { all: true }),
};

export type DomainVerificationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: WorkspaceDomainError };

export function verificationRecordName(hostname: string): string {
  return `${VERIFICATION_TXT_PREFIX}.${hostname}`;
}

export function verificationRecordValue(token: string): string {
  return `${VERIFICATION_TXT_KEY}=${token}`;
}

/** A trailing root dot and case are not part of a name's identity. */
function canonical(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/u, "");
}

/**
 * Bound one lookup. `Promise.race` rather than an AbortSignal because
 * `dns.promises` takes no signal; the losing lookup is abandoned, not cancelled,
 * which is acceptable for a read-only DNS query.
 */
async function bounded<T>(run: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // NXDOMAIN, ENODATA, SERVFAIL and a refused query are all "the record is not
    // there for us", and the caller distinguishes them by WHICH lookup failed.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DomainVerifierOptions {
  readonly hostname: string;
  readonly token: string;
  readonly cnameTarget: string;
  readonly resolver?: DomainDnsResolver;
  readonly timeoutMs?: number;
}

/**
 * Run both checks. Returns the FIRST failure, because the administrator fixes
 * them in order: there is no point reporting a missing CNAME to someone who has
 * not published the ownership record yet.
 */
export async function verifyDomain(
  options: DomainVerifierOptions,
): Promise<DomainVerificationResult> {
  const resolver = options.resolver ?? defaultDomainDnsResolver;
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const hostname = canonical(options.hostname);
  const target = canonical(options.cnameTarget);

  const txt = await bounded(() => resolver.resolveTxt(verificationRecordName(hostname)), timeoutMs);
  if (txt === null) return { ok: false, reason: "txt_missing" };
  // A TXT answer arrives as an array of character-strings per record; a value
  // longer than 255 bytes is split across them and must be rejoined before it
  // is compared. Ours is short, but a provider is free to split anyway.
  const values = txt.map((chunks) => chunks.join("").trim());
  if (values.length === 0) return { ok: false, reason: "txt_missing" };
  if (!values.includes(verificationRecordValue(options.token))) {
    return { ok: false, reason: "txt_mismatch" };
  }

  const cnames = await bounded(() => resolver.resolveCname(hostname), timeoutMs);
  if (cnames !== null && cnames.some((value) => canonical(value) === target)) {
    return { ok: true };
  }

  // Apex fallback: no CNAME is possible at a zone apex, so compare addresses.
  const [hostAddresses, targetAddresses] = await Promise.all([
    bounded(() => resolver.lookup(hostname), timeoutMs),
    bounded(() => resolver.lookup(target), timeoutMs),
  ]);
  if (hostAddresses === null || targetAddresses === null) {
    return { ok: false, reason: "dns_failure" };
  }
  if (hostAddresses.length === 0 || targetAddresses.length === 0) {
    return { ok: false, reason: "cname_mismatch" };
  }
  const allowed = new Set(targetAddresses.map((entry) => entry.address));
  // EVERY address, not any: a host that resolves to us AND to somewhere else is
  // not delegated to us, and treating it as verified would let a claimant keep
  // serving the name elsewhere while holding the globally-unique row here.
  return hostAddresses.every((entry) => allowed.has(entry.address))
    ? { ok: true }
    : { ok: false, reason: "cname_mismatch" };
}

/** DI token for {@link DomainDnsResolver}. Bound in `domains.module.ts`. */
export const DOMAIN_DNS_RESOLVER = Symbol("DOMAIN_DNS_RESOLVER");
