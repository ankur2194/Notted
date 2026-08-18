// Part 65 — public REST API keys: shared constants.
//
// Kept Nest-free so the pure secret helpers, the service, the guard and the
// tests all read the same values without importing a module.

import { API_KEY_SECRET_PREFIX } from "@notted/shared-validators";

/**
 * The literal prefix every raw secret carries. Aliased from the validator
 * package rather than re-typed so the wire format has exactly one definition.
 */
export const API_KEY_PREFIX = API_KEY_SECRET_PREFIX;

/** `audit_logs.entity_type` for an API-key row (varchar(50)). */
export const API_KEY_AUDIT_ENTITY_TYPE = "api_key";

/**
 * `last_used_at` is informational, so it is refreshed at most once per key per
 * minute. Without the throttle a hot key would write a row on every request.
 */
export const API_KEY_LAST_USED_THROTTLE_MS = 60_000;

/** `audit_logs.action` values written by {@link ApiKeysService}. */
export const API_KEY_AUDIT_ACTIONS = Object.freeze({
  created: "apiKey.created",
  revoked: "apiKey.revoked",
} as const);
