// Part 66 — SSRF containment for admin-supplied webhook URLs.
//
// A workspace admin types the destination, so every delivery is a request our
// server makes to an address an outsider chose. Without containment that is a
// ready-made proxy into the private network the API runs in: the cloud metadata
// endpoint, the database, the internal admin app, our own API.
//
// Containment is LAYERED, and each layer has its own test. A comment is not
// containment — that was Part 63's explicit review lesson.
//
//   L1 scheme allow-list          (synchronous, no DNS)
//   L2 no embedded credentials    (synchronous, no DNS)
//   L3 hostname deny-list         (synchronous, no DNS)
//   L4 address deny-list          (`node:net.BlockList`)
//   L5 pre-flight DNS resolution  (every answer must pass L4)
//   L6 connect-time re-check      (`lookup` hook on the socket)
//
// L5 alone is a check-then-use race: a record with TTL 0 can answer publicly
// for the validation lookup and privately for the connect lookup. L6 is what
// makes that rebind land on nothing.

import { promises as dns } from "node:dns";
import { BlockList, isIPv4, isIPv6, type LookupFunction } from "node:net";

export interface WebhookUrlGuardOptions {
  /** `securityConfig.webhookAllowInsecureUrls` — forced false in production. */
  readonly allowInsecureUrls: boolean;
  /** Hostnames of APP_URL / API_URL, lowercased, so an endpoint cannot target us. */
  readonly selfHostnames: readonly string[];
  /**
   * The hostnames `selfHostnames` cannot enumerate: verified custom domains.
   *
   * With `CUSTOM_DOMAINS_ENABLED` every verified `workspace_domains.hostname`
   * also terminates on this deployment, so an admin of workspace A could point
   * a webhook at workspace B's verified host and have the API make
   * authenticated-looking requests to its own front door — the confused-deputy
   * case `selfHostnames` exists to close, one hostname over. That set lives in
   * the database and changes while the process runs, so it is asked, not
   * listed. Optional: a caller with no verified-host source keeps the static
   * behaviour.
   */
  readonly isSelfHost?: (hostname: string) => Promise<boolean>;
}

export type WebhookUrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: "url_rejected" };

/**
 * `error.code` on the L6 rejection. A stable marker, never a message quoting
 * the URL: the URL is admin-supplied and routinely carries a bearer token in
 * its path or query, and this error reaches the logger.
 */
export const WEBHOOK_BLOCKED_ERROR_CODE = "EWEBHOOKBLOCKED";

/** Hostname suffixes that always resolve inside somebody's private network. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"] as const;
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

/**
 * L4 ranges, built ONCE at module load — a `BlockList` is immutable here and
 * rebuilding it per request would put subnet parsing on the delivery path.
 *
 * `allowInsecureUrls` (development only) relaxes ONLY the loopback lists. Every
 * other range — RFC 1918, carrier-grade NAT, link-local and the metadata
 * address that lives in it, multicast, documentation ranges — stays blocked
 * with the flag on, because none of them is ever a legitimate local receiver.
 */
const BLOCKED_ADDRESSES = new BlockList();
const LOOPBACK_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 cloud metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["64:ff9b::", 96], // NAT64 — reaches v4 space through a v6 literal
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addSubnet("::1", 128, "ipv6");

/**
 * The deprecated IPv4-compatible range `::/96`. `unmapIpv4` handles the
 * compressed spellings; `BlockList` canonicalises, so this catches every OTHER
 * spelling (`::0:7f00:1`, `0:0:0:0:0:0:7f00:1`). Checked with explicit
 * carve-outs for the canonical `::` (already `::/128`-blocked) and `::1`
 * (loopback rules apply) — any remaining in-range spelling is denied
 * unconditionally rather than decoded: nothing legitimate uses these forms.
 */
const V4_COMPATIBLE_ADDRESSES = new BlockList();
V4_COMPATIBLE_ADDRESSES.addSubnet("::", 96, "ipv6");

/** `[::1]` from `URL.hostname`, and a `%eth0` zone id, are not addresses. */
function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const zone = unbracketed.indexOf("%");
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone);
}

/**
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the SAME v4 address wearing a v6
 * costume. They are unmapped here and re-checked against the v4 lists rather
 * than trusted to `BlockList`, which is what an "it's IPv6, the v4 rules don't
 * apply" bypass counts on.
 *
 * The deprecated v4-COMPATIBLE forms (`::127.0.0.1`, `::7f00:1`) are unmapped
 * too. Nothing legitimate uses them any more, and leaving them out left the
 * same bypass open one syntax over. `::1` and `::` have too few groups to match
 * either hex pattern, so loopback and unspecified keep their v6 treatment.
 */
function unmapIpv4(address: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address);
  if (dotted !== null) return dotted[1]!;
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** L4. Anything unparseable is blocked: this list denies by default. */
export function isBlockedAddress(address: string, options: WebhookUrlGuardOptions): boolean {
  const normalized = normalizeAddress(address);

  if (isIPv4(normalized)) {
    if (BLOCKED_ADDRESSES.check(normalized, "ipv4")) return true;
    return !options.allowInsecureUrls && LOOPBACK_ADDRESSES.check(normalized, "ipv4");
  }

  if (isIPv6(normalized)) {
    const unmapped = unmapIpv4(normalized);
    if (unmapped !== null) return isBlockedAddress(unmapped, options);
    if (
      normalized !== "::" &&
      normalized !== "::1" &&
      V4_COMPATIBLE_ADDRESSES.check(normalized, "ipv6")
    ) {
      return true;
    }
    if (BLOCKED_ADDRESSES.check(normalized, "ipv6")) return true;
    return !options.allowInsecureUrls && LOOPBACK_ADDRESSES.check(normalized, "ipv6");
  }

  return true;
}

/** L1–L3. Synchronous, no DNS, safe to run on a request thread. */
export function inspectWebhookUrl(raw: string, options: WebhookUrlGuardOptions): WebhookUrlVerdict {
  const rejected = { ok: false, reason: "url_rejected" } as const;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return rejected;
  }

  // L1 — scheme allow-list. `file:`, `ftp:`, `gopher:`, `data:` and
  // `javascript:` are rejected by absence, not by enumeration.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowInsecureUrls)) {
    return rejected;
  }

  // L2 — embedded credentials. `https://user:pass@host` both leaks a
  // credential into our logs and is a classic parser-confusion vector.
  if (url.username !== "" || url.password !== "") return rejected;

  // L3 — hostname deny-list, case-insensitive, trailing dot stripped
  // (`localhost.` resolves exactly like `localhost`).
  const hostname = normalizeAddress(url.hostname).replace(/\.+$/u, "");
  if (hostname === "") return rejected;
  if (BLOCKED_HOSTS.has(hostname)) return rejected;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return rejected;
  if (options.selfHostnames.some((self) => self.toLowerCase() === hostname)) return rejected;

  return { ok: true, url };
}

/** Injectable resolver so the guard's tests need no DNS. */
export type WebhookDnsLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

const defaultLookup: WebhookDnsLookup = (hostname) =>
  dns.lookup(normalizeAddress(hostname), { all: true });

/**
 * L5 — pre-flight resolution.
 *
 * Rejects when ANY returned address is blocked, not merely the first: a
 * split round-robin record that mixes one public answer with one private answer
 * would otherwise pass validation and then connect to whichever the socket
 * happened to pick. An empty answer is a rejection too — there is nothing to
 * approve.
 */
export async function resolveWebhookHost(
  hostname: string,
  options: WebhookUrlGuardOptions,
  lookup: WebhookDnsLookup = defaultLookup,
): Promise<"ok" | "dns_blocked"> {
  // Asked BEFORE the DNS probe: it is the cheaper question (a cached lookup
  // against one indexed row), and there is no reason to resolve a name this
  // deployment already knows is its own. The verdict reuses `dns_blocked`
  // rather than naming a new reason, for the same reason the caller's message
  // is non-specific: which layer refused is a private-network oracle.
  if (options.isSelfHost !== undefined && (await options.isSelfHost(hostname))) {
    return "dns_blocked";
  }

  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return "dns_blocked";
  }
  if (addresses.length === 0) return "dns_blocked";
  return addresses.some((entry) => isBlockedAddress(entry.address, options)) ? "dns_blocked" : "ok";
}

/**
 * L6 — the `lookup` option for `node:http(s).request`.
 *
 * Runs the SAME L4 filter again at socket-connect time, on the answer the
 * socket is actually about to dial. This is what makes a TTL-0 DNS rebind
 * between L5 and connect land on nothing: L5 by itself is a check-then-use
 * race, and the window is exactly one round trip wide.
 */
export function guardedLookup(
  options: WebhookUrlGuardOptions,
  lookup: WebhookDnsLookup = defaultLookup,
): LookupFunction {
  return (hostname, lookupOptions, callback): void => {
    const blocked = (): void => {
      const error: NodeJS.ErrnoException = new Error("Webhook target address is blocked");
      error.code = WEBHOOK_BLOCKED_ERROR_CODE;
      callback(error, []);
    };

    lookup(hostname).then((addresses) => {
      if (addresses.length === 0 || addresses.some((e) => isBlockedAddress(e.address, options))) {
        blocked();
        return;
      }
      // HONOUR THE REQUESTED FAMILY. `net.connect` asks for 4, 6 or 0 (any),
      // and handing back the family it did not ask for makes the socket fail
      // with a connect error that has nothing to do with the endpoint.
      const family = lookupOptions.family;
      const matching =
        family === 4 || family === 6 ? addresses.filter((e) => e.family === family) : addresses;
      const first = matching[0];
      if (first === undefined) {
        // Approved addresses exist, just none in the family the socket asked
        // for (a v4-only host dialled over v6, say). That is a resolution
        // failure, not an SSRF denial — report it as ENOTFOUND so the sender
        // classifies it `connection_failed` instead of `dns_blocked`.
        const error: NodeJS.ErrnoException = new Error(
          `No address with the requested family for ${hostname}`,
        );
        error.code = "ENOTFOUND";
        callback(error, []);
        return;
      }
      if (lookupOptions.all === true) {
        callback(
          null,
          matching.map((entry) => ({ ...entry })),
        );
        return;
      }
      callback(null, first.address, first.family);
    }, blocked);
  };
}
