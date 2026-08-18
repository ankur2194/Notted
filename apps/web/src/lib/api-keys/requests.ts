import { API_KEY_API_PATHS } from "@notted/shared-types";
import {
  apiKeyCreateResultSchema,
  apiKeyListQuerySchema,
  apiKeyPageSchema,
  apiKeyRevokeResultSchema,
  createApiKeySchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type {
  ApiKeyCreateResult,
  ApiKeyListQuery,
  ApiKeyPage,
  ApiKeyRevokeResult,
} from "@notted/shared-types";
import type { CreateApiKeyInput } from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

/**
 * Part 65 — the browser half of workspace API key management.
 *
 * Mirrors `@/lib/tags/requests`: every response is `safeParse`d against the
 * shared schema, so an off-contract body is a failure rather than a silent cast,
 * and route ids are UUID-checked before a request is allowed to leave.
 *
 * Unlike the tag module the *query* is validated in its serialized form.
 * `apiKeyListQuerySchema` reads `includeRevoked` through
 * `explicitBooleanQuerySchema`, whose input is the literal string `"true"` or
 * `"false"` — a parsed `ApiKeyListQuery` (boolean) would be rejected by the
 * schema's own input contract. Checking the params is also the more useful
 * check: it validates exactly what goes on the wire.
 */
function apiKeySearch(query: ApiKeyListQuery): URLSearchParams | null {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  });
  // Omitted rather than sent as `false`: the server's default already hides
  // revoked keys, and an absent selector is one fewer thing to keep in step.
  if (query.includeRevoked === true) params.set("includeRevoked", "true");
  return apiKeyListQuerySchema.safeParse(Object.fromEntries(params)).success ? params : null;
}

/** One page of workspace API keys. Never carries a secret — only prefixes. */
export function listApiKeys(
  workspaceId: string,
  query: ApiKeyListQuery,
): Promise<ApiRequestResult<ApiKeyPage>> {
  const search = apiKeySearch(query);
  if (!validIds(workspaceId) || search === null) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    `${API_KEY_API_PATHS.collection(workspaceId)}?${search.toString()}`,
    {},
    (value) => apiKeyPageSchema.safeParse(value),
  );
}

/**
 * Creates a key and returns the ONLY response that ever carries the raw secret.
 *
 * The idempotency key must be fresh per submission: a replayed create cannot
 * reproduce a secret the caller failed to keep, so reusing one turns a retry
 * into a permanent failure rather than a second usable key.
 */
export function createApiKey(
  workspaceId: string,
  input: CreateApiKeyInput,
  idempotencyKey: string,
): Promise<ApiRequestResult<ApiKeyCreateResult>> {
  const parsed = createApiKeySchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    API_KEY_API_PATHS.collection(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => apiKeyCreateResultSchema.safeParse(value),
  );
}

/** Revoking an already-revoked key is an idempotent success; an absent one 404s. */
export function revokeApiKey(
  workspaceId: string,
  apiKeyId: string,
): Promise<ApiRequestResult<ApiKeyRevokeResult>> {
  if (!validIds(workspaceId, apiKeyId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    API_KEY_API_PATHS.detail(workspaceId, apiKeyId),
    { method: "DELETE" },
    (value) => apiKeyRevokeResultSchema.safeParse(value),
  );
}
