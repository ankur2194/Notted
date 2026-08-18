import type { IsoTimestamp, UserId, WorkspaceId } from "./common";

/**
 * Part 65 — public REST API credentials.
 *
 * API keys are workspace-scoped machine credentials for the `/api/v1` REST
 * surface. The raw secret is returned exactly once, by the create call, and is
 * never retrievable afterwards: only its hash and display prefix are stored.
 */
export const API_KEY_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/api-keys`,
  detail: (workspaceId: string, apiKeyId: string) =>
    `/api/v1/workspaces/${workspaceId}/api-keys/${apiKeyId}`,
} as const);

/** Presented on the wire as `Authorization: Bearer <secret>`. */
export const API_KEY_SECRET_PREFIX = "ntd_pk_" as const;

export type ApiKeyScope = "read" | "write" | "admin";
export type ApiKeySortField = "createdAt" | "lastUsedAt" | "name";

/**
 * Safe projection of an `api_keys` row. `keyHash` is deliberately absent: it is
 * never projected to any transport, log, or audit row.
 */
export interface ApiKeySummary {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /** First eight characters of the raw secret. Cannot authenticate on its own. */
  readonly keyPrefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly lastUsedAt: IsoTimestamp | null;
  readonly expiresAt: IsoTimestamp | null;
  readonly isRevoked: boolean;
  readonly createdById: UserId;
  readonly createdAt: IsoTimestamp;
}

export interface ApiKeyPage {
  readonly items: readonly ApiKeySummary[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface ApiKeyListQuery {
  readonly page: number;
  readonly limit: number;
  readonly includeRevoked?: boolean;
  readonly sortBy: ApiKeySortField;
  readonly sortDirection: "asc" | "desc";
}

/**
 * The only response that ever carries `secret`. Clients must store it
 * immediately; a replayed idempotent create cannot reproduce it and fails
 * instead of returning a key the caller cannot use.
 */
export interface ApiKeyCreateResult {
  readonly apiKey: ApiKeySummary;
  readonly secret: string;
}

export interface ApiKeyRevokeResult {
  readonly apiKeyId: string;
  readonly revoked: true;
}
