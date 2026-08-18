// Part 65 — raw API-key secrets: generation, hashing, scope encoding.
//
// Deliberately pure and Nest-free: no injection, no database, no logger, so
// the credential arithmetic can be reasoned about (and tested) on its own.

import { createHmac, randomBytes } from "node:crypto";

import {
  API_KEY_PREFIX_LENGTH,
  API_KEY_SECRET_PREFIX,
  apiKeyScopeSchema,
} from "@notted/shared-validators";

import type { ApiKeyScope } from "@notted/shared-types";

/** 24 bytes -> exactly 32 base64url characters, 192 bits of entropy. */
const API_KEY_SECRET_BYTES = 24;

/**
 * Domain separation for the HMAC input. Versioned so a future hash change can
 * coexist with `v1` rows instead of silently colliding with them.
 */
const API_KEY_HASH_DOMAIN = "notted:api-key:v1:";

export interface GeneratedApiKeySecret {
  /** Returned to the caller exactly once, by the create response. */
  readonly raw: string;
  /** Display-only fragment stored in `key_prefix` (`varchar(8)`). */
  readonly prefix: string;
}

export function generateApiKeySecret(): GeneratedApiKeySecret {
  const raw = `${API_KEY_SECRET_PREFIX}${randomBytes(API_KEY_SECRET_BYTES).toString("base64url")}`;
  return Object.freeze({ raw, prefix: raw.slice(0, API_KEY_PREFIX_LENGTH) });
}

/**
 * Peppered, deterministic hash of a raw secret.
 *
 * Deterministic ON PURPOSE: authentication is a single unique-index probe of
 * `api_keys_key_hash_unique`, so there is no per-row salt to iterate over and
 * no table scan. The 192-bit random secret — not a work factor — is what makes
 * the input unguessable, so a slow KDF would buy nothing here and would put a
 * CPU cost on every authenticated request.
 *
 * The pepper is `BETTER_AUTH_SECRET` (`authConfig.secret`), which lives in the
 * process environment and never in the database, so a database-only compromise
 * can neither verify a stolen secret nor forge a new row. Same construction as
 * `memberships/invitation-token.service.ts`.
 *
 * ROTATING `BETTER_AUTH_SECRET` INVALIDATES EVERY ISSUED API KEY: each stored
 * hash was computed under the old pepper and can no longer be reproduced. Plan
 * a rotation as a key-reissue event.
 */
export function hashApiKey(raw: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${API_KEY_HASH_DOMAIN}${raw}`, "utf8").digest("hex");
}

/**
 * Decodes the stored `scopes` CSV.
 *
 * Unknown tokens are DROPPED, never passed through: a corrupt or
 * hand-edited row must be able to narrow permission but never to widen it, and
 * dropping degrades the key to fewer scopes instead of turning every request
 * with that key into a 500. Duplicates collapse, so the result always matches
 * `apiKeyScopesSchema`'s uniqueness rule.
 */
export function parseScopes(csv: string): readonly ApiKeyScope[] {
  const seen = new Set<ApiKeyScope>();
  for (const token of csv.split(",")) {
    const parsed = apiKeyScopeSchema.safeParse(token.trim());
    if (parsed.success) seen.add(parsed.data);
  }
  return Object.freeze([...seen]);
}

export function formatScopes(scopes: readonly ApiKeyScope[]): string {
  return scopes.join(",");
}
