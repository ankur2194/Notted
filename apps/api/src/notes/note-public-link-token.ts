//
// Part 82 — raw public-link token generation and hashing. Deliberately pure
// and Nest-free, mirroring `api-keys/api-key-secret.ts` exactly: no
// injection, no database, no logger, so the credential arithmetic can be
// reasoned about (and tested) on its own.

import { createHmac, randomBytes } from "node:crypto";

/** 24 bytes -> exactly 32 base64url characters, 192 bits of entropy. */
const PUBLIC_LINK_TOKEN_BYTES = 24;

/**
 * Domain separation for the HMAC input. A different prefix from
 * `API_KEY_HASH_DOMAIN` (`api-key-secret.ts`) means a public-link token and
 * an API-key secret can never hash-collide even if both were hashed under
 * the same pepper.
 */
const PUBLIC_LINK_HASH_DOMAIN = "notted:note-public-link:v1:";

/** Matches `generatePublicLinkToken`'s output shape. Used to short-circuit a
 * malformed public-GET token to 404 before any DB query. */
export const PUBLIC_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function generatePublicLinkToken(): string {
  return randomBytes(PUBLIC_LINK_TOKEN_BYTES).toString("base64url");
}

/**
 * Peppered, deterministic hash of a raw token. Deterministic on purpose: the
 * public lookup is a single unique-index probe of
 * `note_public_links_token_hash_unique`, not a per-row salted comparison.
 * The pepper is `AUTH_CONFIG.secret` (`BETTER_AUTH_SECRET`), which lives in
 * the process environment and never in the database. Rotating that secret
 * invalidates every issued public link, same as it invalidates every API
 * key.
 */
export function hashPublicLinkToken(raw: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(`${PUBLIC_LINK_HASH_DOMAIN}${raw}`, "utf8")
    .digest("hex");
}
