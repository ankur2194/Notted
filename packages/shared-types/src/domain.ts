import type { IsoTimestamp, WorkspaceId } from "./common";

/**
 * Part 73 — custom domains.
 *
 * A workspace may claim at most ONE hostname; `workspace_domains.workspace_id`
 * is unique. That is why every route below is a singleton (`/domain`) rather
 * than a collection: a second domain would need its own routing precedence
 * rules, its own cookie story, and its own answer to "which one is canonical",
 * and none of that has a use case yet.
 */
export const WORKSPACE_DOMAIN_STATUSES = ["pending", "verified", "error"] as const;
export type WorkspaceDomainStatus = (typeof WORKSPACE_DOMAIN_STATUSES)[number];

/**
 * Why the last verification failed, as a stable vocabulary. The browser renders
 * the remedy; a resolver's own error text never reaches a tenant-readable column.
 */
export const WORKSPACE_DOMAIN_ERRORS = [
  "txt_missing",
  "txt_mismatch",
  "cname_mismatch",
  "dns_failure",
] as const;
export type WorkspaceDomainError = (typeof WORKSPACE_DOMAIN_ERRORS)[number];

/** The DNS label an administrator must publish the ownership token under. */
export const DOMAIN_VERIFICATION_TXT_PREFIX = "_notted-verify" as const;
/** The `name=value` shape of the TXT record's value. */
export const DOMAIN_VERIFICATION_TXT_KEY = "notted-verify" as const;

export interface WorkspaceDomainRecord {
  name: string;
  type: "TXT" | "CNAME";
  value: string;
}

export interface WorkspaceDomain {
  id: string;
  workspaceId: WorkspaceId;
  hostname: string;
  status: WorkspaceDomainStatus;
  lastError: WorkspaceDomainError | null;
  lastCheckedAt: IsoTimestamp | null;
  verifiedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  verificationRecord: WorkspaceDomainRecord;
  cnameRecord: WorkspaceDomainRecord;
}

/** `null` when the workspace has claimed no hostname (or removed the one it had). */
export interface WorkspaceDomainResult {
  domain: WorkspaceDomain | null;
}

/**
 * The ACME / on-demand-TLS seam. PUBLIC and unauthenticated: a certificate
 * issuer holds no session, and a reverse proxy asks this before a TLS handshake
 * can complete. It answers with identifiers only, and 404s for every host that
 * is not verified — which is exactly the "should I issue a certificate for this
 * name" answer Caddy's `on_demand_tls ask` needs.
 */
export const DOMAIN_API_PATHS = Object.freeze({
  resolve: "/api/v1/domains/resolve",
} as const);

export interface DomainResolveResult {
  workspaceId: WorkspaceId;
  slug: string;
}
