// Part 65 — the public REST API reached with a real API key, end to end.
//
// Self-skipping on `DATABASE_URL` exactly like `export.integration.test.ts`:
// self-provisioning (`migrate` + `seedDatabase`), and skipped rather than
// failed when no reachable PostgreSQL is configured.
//
// UNLIKE the unit suites, this one boots the WHOLE application through
// `createApplication()` and drives it with supertest, because what is under
// test is the wiring — the `/api/v1` pre-guard, the rate-limit tier, the
// authorization guard's API-key branch, and the CSRF exemption — none of which
// exists anywhere except in the assembled request pipeline.
//
// BOOTSTRAP. Minting a key over HTTP would need a Better Auth cookie session,
// which needs a verified mailbox and therefore the Mailpit stack (see
// `auth.e2e.test.ts`, gated on `AUTH_E2E`). Keys are therefore written straight
// to `api_keys` using the module's own `generateApiKeySecret`/`hashApiKey` — the
// same functions the service calls — or minted through `ApiKeysService` with a
// fresh session principal. Nothing else about the credential path is faked.
//
// AN API KEY CANNOT MINT OR REVOKE A KEY, AND THAT IS THE SHIPPED POLICY, not a
// gap in this suite. `apiKey.create` and `apiKey.revoke` are HIGH_RISK_ACTIONS;
// the service authorizes them through `authorizeUser` with the SYNTHETIC
// principal the key installs, whose `isFresh` is false by construction. The
// freshness gate therefore answers 403 RECENT_AUTHENTICATION_REQUIRED after
// `decideApiKey` has already accepted the admin scope. A stolen key cannot mint
// a successor, and the tests below assert exactly that — same as
// `webhooks.e2e.test.ts` does for the webhook mutations.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { noteListQuerySchema, tagListQuerySchema } from "@notted/shared-validators";
import { and, eq, like } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatScopes, generateApiKeySecret, hashApiKey } from "../src/api-keys/api-key-secret";
import { ApiKeysService } from "../src/api-keys/api-keys.service";
import { AUTH_CONFIG, type AuthConfig } from "../src/config/auth.config";
import { apiKeys, schema, tags, workspaceMembers } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { createApplication } from "../src/main";
import { NotesService } from "../src/notes/notes.service";
import { TagsService } from "../src/tags/tags.service";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { NestExpressApplication } from "@nestjs/platform-express";
import type { ApiKeyScope, AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const ALPHA = SEED_IDS.workspaces.alpha;
const BETA = SEED_IDS.workspaces.beta;

const ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "APP_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "LOG_LEVEL",
  "RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE",
  "RATE_LIMIT_AUTHENTICATED_PER_MINUTE",
  "RATE_LIMIT_API_KEY_PER_MINUTE",
  "RATE_LIMIT_SENSITIVE_PER_MINUTE",
  "FEATURE_REDIS_ENABLED",
  "FEATURE_REALTIME_ENABLED",
  "FEATURE_STORAGE_ENABLED",
  "FEATURE_SEARCH_ENABLED",
  "FEATURE_EMAIL_ENABLED",
] as const;

type EnvironmentSnapshot = Readonly<Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>>;

function snapshotEnvironment(): EnvironmentSnapshot {
  return Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as EnvironmentSnapshot;
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** DATABASE_URL is deliberately NOT overridden: this suite needs the real one. */
function applyEnvironment(overrides: Readonly<Record<string, string>>): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
    LOG_LEVEL: "silent",
    RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "1000",
    RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "1000",
    RATE_LIMIT_API_KEY_PER_MINUTE: "1000",
    RATE_LIMIT_SENSITIVE_PER_MINUTE: "100",
    FEATURE_REDIS_ENABLED: "false",
    FEATURE_REALTIME_ENABLED: "false",
    FEATURE_STORAGE_ENABLED: "false",
    FEATURE_SEARCH_ENABLED: "false",
    FEATURE_EMAIL_ENABLED: "false",
    ...overrides,
  });
}

/** The synthetic principal `ApiKeyAuthService` installs for the key's creator. */
function creatorPrincipal(userId: string, apiKeyId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `api-key:${apiKeyId}`,
    method: "api-key" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    isFresh: false,
  });
}

/** A real cookie-session principal: fresh, so high-risk actions are allowed. */
function sessionPrincipal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: randomUUID(),
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    isFresh: true,
  });
}

interface SeededKey {
  readonly id: string;
  readonly raw: string;
  readonly prefix: string;
}

/**
 * Every name this suite gives a key. `afterAll` deletes by these prefixes so a
 * shared development database does not accumulate a row per run.
 */
const KEY_NAME_PREFIXES = ["e2e %", "minted-%", "revocable-%"] as const;

async function removeSuiteKeys(db: NodePgDatabase<typeof schema> | undefined): Promise<void> {
  if (db === undefined) return;
  for (const prefix of KEY_NAME_PREFIXES) {
    await db.delete(apiKeys).where(like(apiKeys.name, prefix));
  }
}

async function seedKey(
  db: NodePgDatabase<typeof schema>,
  pepper: string,
  input: {
    readonly workspaceId: string;
    readonly createdById: string;
    readonly scopes: readonly ApiKeyScope[];
  },
): Promise<SeededKey> {
  const id = randomUUID();
  const secret = generateApiKeySecret();
  await db.insert(apiKeys).values({
    id,
    workspaceId: input.workspaceId,
    createdById: input.createdById,
    name: `e2e ${id.slice(0, 8)}`,
    keyHash: hashApiKey(secret.raw, pepper),
    keyPrefix: secret.prefix,
    scopes: formatScopes([...input.scopes]),
  });
  return { id, raw: secret.raw, prefix: secret.prefix };
}

async function countTags(db: NodePgDatabase<typeof schema>, workspaceId: string): Promise<number> {
  const rows = await db.select({ id: tags.id }).from(tags).where(eq(tags.workspaceId, workspaceId));
  return rows.length;
}

async function countKeys(db: NodePgDatabase<typeof schema>, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId));
  return rows.length;
}

describe.skipIf(!HAS_DATABASE)("Part 65 public REST API with API keys", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let app: NestExpressApplication | undefined;
  let environment: EnvironmentSnapshot;

  let adminKey: SeededKey;
  let readKey: SeededKey;
  let writeKey: SeededKey;
  let betaKey: SeededKey;

  beforeAll(async () => {
    environment = snapshotEnvironment();
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.transaction(async (tx) => seedDatabase(tx));

    applyEnvironment({});
    app = await createApplication();
    await app.init();
    const pepper = app.get<AuthConfig>(AUTH_CONFIG).secret;

    adminKey = await seedKey(db, pepper, {
      workspaceId: ALPHA,
      createdById: SEED_IDS.users.alphaOwner,
      scopes: ["admin", "read", "write"],
    });
    readKey = await seedKey(db, pepper, {
      workspaceId: ALPHA,
      createdById: SEED_IDS.users.alphaOwner,
      scopes: ["read"],
    });
    writeKey = await seedKey(db, pepper, {
      workspaceId: ALPHA,
      createdById: SEED_IDS.users.alphaAdmin,
      scopes: ["read", "write"],
    });
    betaKey = await seedKey(db, pepper, {
      workspaceId: BETA,
      createdById: SEED_IDS.users.betaOwner,
      scopes: ["read", "write"],
    });
  }, 180_000);

  afterAll(async () => {
    // Every key this suite writes, seeded or minted, deleted by the names it
    // uses — otherwise a shared development database keeps one row per run.
    await removeSuiteKeys(db);
    await app?.close();
    await pool?.end();
    restoreEnvironment(environment);
  });

  function server() {
    return (app as NestExpressApplication).getHttpServer();
  }

  function bearer(key: SeededKey): string {
    return `Bearer ${key.raw}`;
  }

  // ------------------------------------------------------------------ //
  // Contract parity: REST behaviour === application-service behaviour.
  // ------------------------------------------------------------------ //

  it("returns the same tag page over REST as TagsService.list does directly", async () => {
    const response = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", bearer(readKey))
      .expect(200);

    // The query defaults come from the SAME schema the controller applies, so
    // this stays a parity assertion rather than a copy of today's defaults.
    const direct = await (app as NestExpressApplication).get(TagsService).list({
      principal: creatorPrincipal(SEED_IDS.users.alphaOwner, readKey.id),
      workspaceId: ALPHA,
      requestId: null,
      ...tagListQuerySchema.parse({}),
    });

    // ADR 0013: successful responses return the resource payload directly
    // (errors alone carry the `{success:false,error,requestId}` envelope).
    expect(response.body).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(response.body.items.length).toBeGreaterThan(0);
  });

  it("returns the same paginated note page over REST as NotesService.list does directly", async () => {
    const response = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/notes`)
      .query({ page: "1", limit: "2" })
      .set("Authorization", bearer(readKey))
      .expect(200);

    const direct = await (app as NestExpressApplication).get(NotesService).list({
      principal: creatorPrincipal(SEED_IDS.users.alphaOwner, readKey.id),
      workspaceId: ALPHA,
      requestId: null,
      ...noteListQuerySchema.parse({ page: "1", limit: "2" }),
    });

    expect(response.body).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(response.body.limit).toBe(2);
  });

  // ------------------------------------------------------------------ //
  // Scope enforcement.
  // ------------------------------------------------------------------ //

  it("refuses a write with a read-only key and leaves no row behind", async () => {
    const before = await countTags(db as NodePgDatabase<typeof schema>, ALPHA);

    const response = await request(server())
      .post(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", bearer(readKey))
      .set("Idempotency-Key", randomUUID())
      .send({ name: `read-scope-denied-${randomUUID().slice(0, 8)}`, color: "#2563eb" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    // The denial is authorization, not a failed insert: prove nothing landed.
    expect(await countTags(db as NodePgDatabase<typeof schema>, ALPHA)).toBe(before);
  });

  /**
   * REGRESSION. `PUT .../shares/:userId` is a delegation grant, and it declared
   * `note.read` — a read-class action — so `decideApiKey` waved a read-only key
   * straight through and the service's own `note.share` check then ran as the
   * key's CREATOR and passed. The route now declares the management action, and
   * `ApiKeyRouteGuard` refuses an unsafe method from a read-only key whatever
   * the route declares, so this is denied twice over.
   */
  it("refuses a delegation grant from a read-only key", async () => {
    const notes = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/notes`)
      .query({ page: "1", limit: "1" })
      .set("Authorization", bearer(readKey))
      .expect(200);
    const noteId = notes.body.items[0]?.id as string | undefined;
    if (noteId === undefined) throw new Error("The seeded workspace has no note to share");

    const response = await request(server())
      .put(`/api/v1/workspaces/${ALPHA}/notes/${noteId}/shares/${SEED_IDS.users.alphaEditor}`)
      .set("Authorization", bearer(readKey))
      .send({ permission: "edit" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("caps a write-scope key at its creator's live workspace role (scope ∩ role)", async () => {
    const database = db as NodePgDatabase<typeof schema>;
    const membership = and(
      eq(workspaceMembers.workspaceId, ALPHA),
      eq(workspaceMembers.userId, SEED_IDS.users.alphaAdmin),
    );

    // The key still carries `write`; only the human behind it is demoted.
    const allowed = await request(server())
      .post(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", bearer(writeKey))
      .set("Idempotency-Key", randomUUID())
      .send({ name: `scope-role-${randomUUID().slice(0, 8)}`, color: "#0f766e" });
    expect(allowed.status).toBe(201);

    await database.update(workspaceMembers).set({ role: "viewer" }).where(membership);
    try {
      const denied = await request(server())
        .post(`/api/v1/workspaces/${ALPHA}/tags`)
        .set("Authorization", bearer(writeKey))
        .set("Idempotency-Key", randomUUID())
        .send({ name: `scope-role-${randomUUID().slice(0, 8)}`, color: "#0f766e" });
      expect(denied.status).toBe(403);
    } finally {
      await database.update(workspaceMembers).set({ role: "admin" }).where(membership);
    }
  });

  /**
   * NOTE for future maintainers: the seeded tenants have DISJOINT membership
   * (`alphaAdmin` belongs only to alpha, `betaOwner` only to beta), so this
   * case would still pass even if the workspace-binding check in
   * `AuthorizationHttpGuard` were deleted — the creator's membership lookup
   * would reject it downstream anyway. The case that actually needs the guard
   * is a creator who belongs to BOTH workspaces; it is covered directly in
   * `src/authorization/authorization-http.test.ts`. Do not treat this test as
   * the binding's only proof.
   */
  it("conceals another tenant's workspace as 404 rather than 403", async () => {
    const response = await request(server())
      .get(`/api/v1/workspaces/${BETA}/tags`)
      .set("Authorization", bearer(readKey));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");

    // Symmetrical: the beta key cannot see alpha either.
    const reverse = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", bearer(betaKey));
    expect(reverse.status).toBe(404);
  });

  // ------------------------------------------------------------------ //
  // Default-deny blast radius.
  // ------------------------------------------------------------------ //

  it("refuses a /api/v1 route that declares no authorization spec", async () => {
    const response = await request(server()).get("/api/v1").set("Authorization", bearer(readKey));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses an API key on the first-party tRPC transport", async () => {
    const response = await request(server())
      .get("/api/v1/trpc/health.ping")
      .set("Authorization", bearer(readKey));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  /*
   * The refusal above used to be a string comparison against the request line —
   * `startsWith("Bearer ntd_pk_")` on the header, `startsWith(TRPC_PATH)` on
   * `baseUrl + path` — and BOTH halves could be walked past, because neither
   * matched what the code downstream actually does.
   *
   * `bearerSecret` splits on the first space, lowercases the scheme and trims
   * the value, so every header below authenticates as an API key. Express
   * routes case-insensitively by default and nothing sets `case sensitive
   * routing`, so `/api/v1/TRPC/...` reaches the tRPC handler while a
   * case-sensitive `startsWith` misses it.
   *
   * Landing on tRPC is not a soft failure: it is mounted outside the Nest
   * pipeline, so `ApiKeyRouteGuard` never runs and the scopes are never read —
   * a read-only key would execute writes as the key's creator.
   */
  it.each([
    ["lowercase scheme", "/api/v1/trpc/health.ping", (raw: string) => `bearer ${raw}`],
    ["uppercase scheme", "/api/v1/trpc/health.ping", (raw: string) => `BEARER ${raw}`],
    ["doubled space", "/api/v1/trpc/health.ping", (raw: string) => `Bearer  ${raw}`],
    ["trailing whitespace", "/api/v1/trpc/health.ping", (raw: string) => `Bearer ${raw} `],
    ["uppercase path", "/api/v1/TRPC/health.ping", (raw: string) => `Bearer ${raw}`],
  ])("refuses an API key on tRPC despite %s", async (_label, path, header) => {
    const response = await request(server()).get(path).set("Authorization", header(readKey.raw));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a malformed bearer credential as 401, never as a 503 outage", async () => {
    const response = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", "Bearer ntd_pk_00000000000000000000000000000000");

    expect(response.status).toBe(401);
    expect(response.body.error.code).not.toBe("SERVICE_UNAVAILABLE");
  });

  // ------------------------------------------------------------------ //
  // Storage: the raw secret never reaches the database.
  // ------------------------------------------------------------------ //

  it("stores only a peppered hash and an 8-character display prefix", async () => {
    const rows = await (db as NodePgDatabase<typeof schema>)
      .select({ keyHash: apiKeys.keyHash, keyPrefix: apiKeys.keyPrefix })
      .from(apiKeys)
      .where(eq(apiKeys.id, readKey.id));
    const row = rows[0];
    if (row === undefined) throw new Error("The seeded key row is missing");

    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.keyPrefix).toBe(readKey.raw.slice(0, 8));
    expect(row.keyPrefix).toHaveLength(8);
    // Nothing stored may contain the secret beyond the display prefix.
    const stored = `${row.keyHash}${row.keyPrefix}`;
    expect(stored).not.toContain(readKey.raw);
    expect(stored).not.toContain(readKey.raw.slice(8));
    // Not even one character beyond the display prefix survives anywhere.
    expect(stored).not.toContain(readKey.raw.slice(0, 9));
  });

  // ------------------------------------------------------------------ //
  // Management endpoints, driven over the real REST surface.
  // ------------------------------------------------------------------ //

  it("requires an Idempotency-Key to mint a key", async () => {
    const response = await request(server())
      .post(`/api/v1/workspaces/${ALPHA}/api-keys`)
      .set("Authorization", bearer(adminKey))
      .send({ name: "no idempotency key", scopes: ["read"] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuses to mint a successor key from an API key, however wide its scope", async () => {
    const before = await countKeys(db as NodePgDatabase<typeof schema>, ALPHA);

    const response = await request(server())
      .post(`/api/v1/workspaces/${ALPHA}/api-keys`)
      .set("Authorization", bearer(adminKey))
      .set("Idempotency-Key", randomUUID())
      .send({ name: `minted-${randomUUID().slice(0, 8)}`, scopes: ["read"] });

    // The admin scope satisfied `decideApiKey`; the FRESHNESS gate is what
    // refuses, and it is the reason a stolen key cannot outlive its revocation.
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("RECENT_AUTHENTICATION_REQUIRED");
    expect(await countKeys(db as NodePgDatabase<typeof schema>, ALPHA)).toBe(before);
  });

  it("returns the raw secret exactly once and refuses to replay it", async () => {
    // Minted through the service with a FRESH session principal, because the
    // gate above makes the REST path unavailable to a key. Everything under
    // test here — the secret shape, the projection, the idempotency replay —
    // lives in the service and is identical on both transports.
    const service = (app as NestExpressApplication).get(ApiKeysService);
    const principal = sessionPrincipal(SEED_IDS.users.alphaOwner);
    const idempotencyKey = randomUUID();
    const payload = {
      principal,
      workspaceId: ALPHA,
      requestId: null,
      name: `minted-${randomUUID().slice(0, 8)}`,
      scopes: ["read" as const],
      idempotencyKey,
    };

    const created = await service.create(payload);

    expect(created.secret).toMatch(/^ntd_pk_[A-Za-z0-9_-]{32}$/u);
    expect(created.apiKey).not.toHaveProperty("keyHash");
    expect(created.apiKey.keyPrefix).toBe(created.secret.slice(0, 8));

    // The secret cannot be recomputed, so a replay must fail loudly rather than
    // hand back a key row the caller can never authenticate with.
    await expect(service.create(payload)).rejects.toMatchObject({
      safeResponse: { code: "IDEMPOTENT_RESULT_UNAVAILABLE" },
    });

    // The minted key really works over the public surface.
    await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", `Bearer ${created.secret}`)
      .expect(200);
  });

  it("never projects the stored hash through the list endpoint", async () => {
    const response = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/api-keys`)
      .set("Authorization", bearer(adminKey))
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
    for (const item of response.body.items) {
      expect(item).not.toHaveProperty("keyHash");
    }
    expect(JSON.stringify(response.body)).not.toContain(adminKey.raw);
  });

  it("stops a revoked key immediately, with no restart and no cache flush", async () => {
    const service = (app as NestExpressApplication).get(ApiKeysService);
    const scope = {
      principal: sessionPrincipal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
    };
    const created = await service.create({
      ...scope,
      name: `revocable-${randomUUID().slice(0, 8)}`,
      scopes: ["read"],
      idempotencyKey: randomUUID(),
    });
    const secret = created.secret;
    const apiKeyId = created.apiKey.id;

    await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", `Bearer ${secret}`)
      .expect(200);

    // Revoking is high-risk too, so the key holding the credential cannot do it.
    const selfRevoke = await request(server())
      .delete(`/api/v1/workspaces/${ALPHA}/api-keys/${apiKeyId}`)
      .set("Authorization", bearer(adminKey));
    expect(selfRevoke.status).toBe(403);
    expect(selfRevoke.body.error.code).toBe("RECENT_AUTHENTICATION_REQUIRED");

    expect(await service.revoke({ ...scope, apiKeyId })).toEqual({ apiKeyId, revoked: true });

    const after = await request(server())
      .get(`/api/v1/workspaces/${ALPHA}/tags`)
      .set("Authorization", `Bearer ${secret}`);
    expect(after.status).toBe(401);

    // Revocation is idempotent, and an absent key is a 404.
    expect(await service.revoke({ ...scope, apiKeyId })).toEqual({ apiKeyId, revoked: true });
    // A key that is not ours is concealed as 404, never confirmed as 403.
    await expect(service.revoke({ ...scope, apiKeyId: randomUUID() })).rejects.toMatchObject({
      decision: { code: "authorization.concealed", httpStatus: 404 },
    });
  });
});

/**
 * The API-key tier blocks at its own configured threshold WITHOUT taking any
 * other tier down with it. A second application instance is needed because the
 * limit is read once at boot.
 *
 * The other leg here is the unauthenticated per-IP tier rather than a cookie
 * session: minting a Better Auth cookie requires the Mailpit stack behind
 * `AUTH_E2E` (see `auth.e2e.test.ts`), which this DATABASE_URL-only suite does
 * not start. The user tier's independence from the API-key tier is proved in
 * `src/common/rate-limit/rate-limit.service.test.ts`, which drains each of the
 * three tiers in turn and asserts the other two still pass.
 */
describe.skipIf(!HAS_DATABASE)("Part 65 API-key rate-limit tier", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let app: NestExpressApplication | undefined;
  let environment: EnvironmentSnapshot;
  let key: SeededKey;

  beforeAll(async () => {
    environment = snapshotEnvironment();
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 4 });
    db = drizzle(pool, { schema });
    // Idempotent, and it keeps this suite runnable on its own under `-t`.
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.transaction(async (tx) => seedDatabase(tx));

    applyEnvironment({
      RATE_LIMIT_API_KEY_PER_MINUTE: "1",
      RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "100",
    });
    app = await createApplication();
    await app.init();
    key = await seedKey(db, app.get<AuthConfig>(AUTH_CONFIG).secret, {
      workspaceId: ALPHA,
      createdById: SEED_IDS.users.alphaOwner,
      scopes: ["read"],
    });
  }, 180_000);

  afterAll(async () => {
    await removeSuiteKeys(db);
    await app?.close();
    await pool?.end();
    restoreEnvironment(environment);
  });

  it("429s the second API-key request while another tier still succeeds", async () => {
    const server = (app as NestExpressApplication).getHttpServer();
    const path = `/api/v1/workspaces/${ALPHA}/tags`;

    const first = await request(server).get(path).set("Authorization", `Bearer ${key.raw}`);
    expect(first.status).toBe(200);
    expect(first.headers["ratelimit-limit"]).toBe("1");

    const second = await request(server).get(path).set("Authorization", `Bearer ${key.raw}`);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("RATE_LIMITED");
    expect(second.headers["retry-after"]).toBeDefined();

    // The unauthenticated per-IP bucket is untouched by the exhausted key.
    const other = await request(server).get("/api/v1");
    expect(other.status).toBe(200);
    expect(other.headers["ratelimit-limit"]).toBe("100");
  });
});
