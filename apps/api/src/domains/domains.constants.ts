// Part 73 — stable identifiers for the custom-domain audit trail.

/**
 * Audit `action` verbs for `audit_logs` rows written by `DomainsService`.
 *
 * All three carry IDENTIFIERS AND THE HOSTNAME ONLY. The hostname is public by
 * construction — it is a name in the global DNS and the whole point of the
 * feature is that browsers send it in the clear — so it is a fact an auditor
 * needs rather than a secret. The verification TOKEN never appears: it is not a
 * credential either, but `audit_logs` is CSV-exportable to every workspace
 * admin and there is nothing an auditor learns from it.
 */
export const DOMAIN_AUDIT_ACTIONS = Object.freeze({
  set: "domain.set",
  verify: "domain.verify",
  remove: "domain.remove",
} as const);

/** `audit_logs.entity_type` for custom-domain events. */
export const DOMAIN_AUDIT_ENTITY_TYPE = "workspace_domain" as const;

/** PostgreSQL constraint names the service maps to a specific 409. */
export const WORKSPACE_DOMAINS_HOSTNAME_UNIQUE = "workspace_domains_hostname_unique";
export const WORKSPACE_DOMAINS_WORKSPACE_UNIQUE = "workspace_domains_workspace_id_unique";

/** 32 bytes of hex — the token published in the ownership TXT record. */
export const DOMAIN_VERIFICATION_TOKEN_BYTES = 16;
