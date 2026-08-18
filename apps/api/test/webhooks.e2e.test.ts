// Part 66 — the webhook REST surface reached through the assembled application.
//
// Modelled directly on `api-keys.e2e.test.ts`: self-skipping on `DATABASE_URL`,
// self-provisioning (`migrate` + `seedDatabase`), and booting the WHOLE app
// through `createApplication()` so what is exercised is the wiring — the
// `/api/v1` pre-guard, the default-deny `ApiKeyRouteGuard`, the authorization
// guard's API-key branch and its key↔route workspace binding — none of which
// exists anywhere except in the assembled request pipeline.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE ADDING A CASE: WHY HALF THE SURFACE IS DRIVEN THROUGH THE
// SERVICE AND NOT THROUGH SUPERTEST.
//
// An API key is the only credential a `DATABASE_URL`-only suite can mint (a
// cookie session needs the Mailpit stack behind `AUTH_E2E`; see
// `auth.e2e.test.ts`). And an API key installs a synthetic principal with
// `isFresh: false` — deliberately, because "a machine credential is never
// recently authenticated". `webhook.create`, `webhook.update` and
// `webhook.delete` are `HIGH_RISK_ACTIONS`, and that gate is checked in
// `AuthorizationPolicyService.decide` BEFORE the role branch, on the
// SERVICE-layer `authorizeUser` call every controller makes. So:
//
//   * `GET /webhooks`, `GET /webhooks/{id}/deliveries` and
//     `POST .../deliveries/{id}/retry` ARE reachable with an admin-scoped key.
//   * `POST /webhooks`, `PATCH`, `DELETE`, `POST /rotate-secret` and
//     `POST /verify` are 403 `RECENT_AUTHENTICATION_REQUIRED` for EVERY API
//     key, whatever its scope and whatever its creator's role. That is asserted
//     below rather than worked around, because it is the shipped behaviour.
//
// The mutation clauses (secret-once, the endpoint cap, enabling an unverified
// endpoint, the URL reset) are therefore driven through `WebhooksService`
// obtained from the booted container with a FRESH principal — the same
// bootstrap concession `api-keys.e2e.test.ts` makes when it writes its first
// key straight to `api_keys` because minting one over HTTP needs a session.
// Everything else about the path is real: real DI, real policies, real SQL.
// ---------------------------------------------------------------------------
//
// NO OUTBOUND HTTP EXCEPT ONE LOOPBACK VERIFICATION PROBE. Endpoint URLs point
// at 127.0.0.1 because `WebhooksService.create` resolves the host through the
// SSRF guard before it accepts a row, and `WEBHOOK_ALLOW_INSECURE_URLS=true`
// unblocks loopback (and only loopback) for this run. The single receiver is an
// in-process `node:http` server, never a container: the api container cannot
// reach an arbitrary host port.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import {
  WEBHOOK_API_PATHS,
  WEBHOOK_ENDPOINT_LIMIT,
  WEBHOOK_SECRET_PREFIX,
} from "@notted/shared-types";
import { webhookCreateSchema } from "@notted/shared-validators";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { formatScopes, generateApiKeySecret, hashApiKey } from "../src/api-keys/api-key-secret";
import { AUTH_CONFIG, type AuthConfig } from "../src/config/auth.config";
import { apiKeys, auditLogs, schema, webhooks } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { createApplication } from "../src/main";
import { WebhooksService } from "../src/webhooks/webhooks.service";

import type { NestExpressApplication } from "@nestjs/platform-express";
import type { ApiKeyScope, AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const ALPHA = SEED_IDS.workspaces.alpha;
const BETA = SEED_IDS.workspaces.beta;

/** Never dialled by `create` — the guard resolves the host, it does not connect. */
const LOOPBACK = (suffix: string): string => `http://127.0.0.1:9/hook-${suffix}`;

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
  "WEBHOOK_ALLOW_INSECURE_URLS",
  "WEBHOOK_REQUEST_TIMEOUT_MS",
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
    RATE_LIMIT_SENSITIVE_PER_MINUTE: "1000",
    FEATURE_REDIS_ENABLED: "false",
    FEATURE_REALTIME_ENABLED: "false",
    FEATURE_STORAGE_ENABLED: "false",
    FEATURE_SEARCH_ENABLED: "false",
    FEATURE_EMAIL_ENABLED: "false",
    // Unblocks `http:` and LOOPBACK ONLY. Every private and link-local range
    // stays blocked; `webhooks.integration.test.ts` asserts exactly that.
    WEBHOOK_ALLOW_INSECURE_URLS: "true",
    WEBHOOK_REQUEST_TIMEOUT_MS: "2000",
    ...overrides,
  });
}

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A fresh session principal — `webhook.create` and `webhook.update` demand one. */
function freshPrincipal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `webhooks-e2e:${userId}`,
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

interface SeededKey {
  readonly id: string;
  readonly raw: string;
}

/** Identical to `api-keys.e2e.test.ts`: the module's own secret primitives. */
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
    name: `webhooks e2e ${id.slice(0, 8)}`,
    keyHash: hashApiKey(secret.raw, pepper),
    keyPrefix: secret.prefix,
    scopes: formatScopes([...input.scopes]),
  });
  return { id, raw: secret.raw };
}

type Method = "get" | "post" | "patch" | "delete";

interface Route {
  readonly name: string;
  readonly method: Method;
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

const servers: Server[] = [];

/** One in-process receiver that echoes the verification challenge back. */
async function startEchoReceiver(): Promise<string> {
  const server = createServer((incoming, response) => {
    incoming.on("error", () => undefined);
    response.on("error", () => undefined);
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        data: { challenge: string };
      };
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(body.data.challenge);
    });
  });
  server.on("clientError", () => undefined);
  servers.push(server);
  await new Promise<void>((listening) => {
    server.listen(0, "127.0.0.1", listening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The receiver did not bind to an ephemeral port");
  }
  return `http://127.0.0.1:${address.port}/hook`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => {
    server.close(() => done());
  });
}

describe.skipIf(!HAS_DATABASE_URL)("Part 66 webhook REST surface", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let app: NestExpressApplication | undefined;
  let environment: EnvironmentSnapshot;
  let live = false;

  let adminKey: SeededKey;
  let readKey: SeededKey;
  let editorKey: SeededKey;
  let viewerKey: SeededKey;
  let betaKey: SeededKey;

  beforeAll(async () => {
    environment = snapshotEnvironment();
    live = await reachable(DATABASE_URL as string);
    if (!live) return;
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
    // Admin SCOPE, non-admin ROLE. Effective permission is scope ∩ creator role,
    // so these two prove the role half of that intersection.
    editorKey = await seedKey(db, pepper, {
      workspaceId: ALPHA,
      createdById: SEED_IDS.users.alphaEditor,
      scopes: ["admin", "read", "write"],
    });
    viewerKey = await seedKey(db, pepper, {
      workspaceId: ALPHA,
      createdById: SEED_IDS.users.alphaViewer,
      scopes: ["admin", "read", "write"],
    });
    betaKey = await seedKey(db, pepper, {
      workspaceId: BETA,
      createdById: SEED_IDS.users.betaOwner,
      scopes: ["admin", "read", "write"],
    });
  }, 180_000);

  afterEach(async () => {
    for (const server of servers.splice(0)) await closeServer(server);
    if (!live || db === undefined) return;
    // Every test starts from an empty endpoint list, which is what makes the
    // endpoint-cap case meaningful rather than order-dependent.
    const rows = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ALPHA));
    for (const row of rows) {
      await db.delete(auditLogs).where(eq(auditLogs.entityId, row.id));
      await db.delete(webhooks).where(eq(webhooks.id, row.id));
    }
  });

  afterAll(async () => {
    if (live && db !== undefined) {
      for (const key of [adminKey, readKey, editorKey, viewerKey, betaKey]) {
        if (key !== undefined) await db.delete(apiKeys).where(eq(apiKeys.id, key.id));
      }
    }
    await app?.close();
    await pool?.end();
    restoreEnvironment(environment);
  });

  function server() {
    return (app as NestExpressApplication).getHttpServer();
  }

  function service(): WebhooksService {
    return (app as NestExpressApplication).get(WebhooksService);
  }

  function bearer(key: SeededKey): string {
    return `Bearer ${key.raw}`;
  }

  /** Registers one endpoint through the service, as a fresh workspace owner. */
  function registerEndpoint(url = LOOPBACK(randomUUID().slice(0, 8))) {
    return service().create({
      principal: freshPrincipal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
      url,
      events: ["note.created"],
    });
  }

  /** Every route on this controller, addressed at `workspaceId`. */
  function allRoutes(workspaceId: string, webhookId: string, deliveryId: string): Route[] {
    return [
      { name: "GET collection", method: "get", path: WEBHOOK_API_PATHS.collection(workspaceId) },
      {
        name: "POST collection",
        method: "post",
        path: WEBHOOK_API_PATHS.collection(workspaceId),
        // A VALID body on purpose: an invalid one would 400 at the controller's
        // Zod gate and never reach the authorization this case is about.
        body: { url: LOOPBACK("denied"), events: ["note.created"] },
      },
      {
        name: "PATCH detail",
        method: "patch",
        path: WEBHOOK_API_PATHS.detail(workspaceId, webhookId),
        body: { events: ["note.updated"] },
      },
      {
        name: "DELETE detail",
        method: "delete",
        path: WEBHOOK_API_PATHS.detail(workspaceId, webhookId),
      },
      {
        name: "POST rotate-secret",
        method: "post",
        path: WEBHOOK_API_PATHS.rotateSecret(workspaceId, webhookId),
      },
      {
        name: "POST verify",
        method: "post",
        path: WEBHOOK_API_PATHS.verify(workspaceId, webhookId),
      },
      {
        name: "GET deliveries",
        method: "get",
        path: WEBHOOK_API_PATHS.deliveries(workspaceId, webhookId),
      },
      {
        name: "POST retry",
        method: "post",
        path: WEBHOOK_API_PATHS.retryDelivery(workspaceId, webhookId, deliveryId),
      },
    ];
  }

  function call(route: Route, key: SeededKey) {
    const agent = request(server());
    const pending =
      route.method === "get"
        ? agent.get(route.path)
        : route.method === "post"
          ? agent.post(route.path)
          : route.method === "patch"
            ? agent.patch(route.path)
            : agent.delete(route.path);
    const authorized = pending.set("Authorization", bearer(key));
    return route.body === undefined ? authorized : authorized.send(route.body);
  }

  // ------------------------------------------------------------------ //
  // Role denial: `webhook.*` is admin-only, end to end.
  // ------------------------------------------------------------------ //

  it("denies an editor and a viewer on every route, admin scope notwithstanding", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();
    const routes = allRoutes(ALPHA, webhook.id, randomUUID());
    expect(routes).toHaveLength(8);

    for (const key of [editorKey, viewerKey]) {
      for (const route of routes) {
        const response = await call(route, key);
        expect({ route: route.name, status: response.status }).toEqual({
          route: route.name,
          status: 403,
        });
      }
    }

    // On the routes that are NOT `HIGH_RISK_ACTIONS`, the 403 is the role
    // denial itself rather than the freshness gate — so this really is
    // `editorAllowed`/`viewerAllowed` refusing every `webhook.*` action.
    for (const key of [editorKey, viewerKey]) {
      for (const path of [
        WEBHOOK_API_PATHS.collection(ALPHA),
        WEBHOOK_API_PATHS.deliveries(ALPHA, webhook.id),
      ]) {
        const response = await request(server()).get(path).set("Authorization", bearer(key));
        expect(response.body.error.code).toBe("FORBIDDEN");
      }
    }
  });

  // ------------------------------------------------------------------ //
  // Cross-tenant: 404, never 403. Existence must not leak.
  // ------------------------------------------------------------------ //

  it("conceals another tenant's webhook as 404 on every route, including deliveries and retry", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();

    for (const route of allRoutes(ALPHA, webhook.id, randomUUID())) {
      const response = await call(route, betaKey);
      expect({ route: route.name, status: response.status }).toEqual({
        route: route.name,
        status: 404,
      });
      expect(response.body.error.code).toBe("NOT_FOUND");
    }

    // Symmetrical, and specifically NOT 403: an alpha key must not learn that
    // the beta workspace exists either.
    const reverse = await request(server())
      .get(WEBHOOK_API_PATHS.collection(BETA))
      .set("Authorization", bearer(adminKey));
    expect(reverse.status).toBe(404);
    expect(reverse.body.error.code).toBe("NOT_FOUND");
  });

  // ------------------------------------------------------------------ //
  // The signing secret is returned exactly twice in the product's life —
  // create and rotate — and never again.
  // ------------------------------------------------------------------ //

  it("returns the raw secret only from create and rotate, never from a read path", async () => {
    if (!live) return;
    const created = await registerEndpoint();
    expect(created.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
    // Serialized, not just key-checked: a nested leak would survive a
    // `toHaveProperty` assertion.
    expect(JSON.stringify(created.webhook)).not.toContain(created.secret);
    expect(JSON.stringify(created.webhook)).not.toContain("encryptedSecret");

    const rotated = await service().rotateSecret({
      principal: freshPrincipal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
      webhookId: created.webhook.id,
    });
    expect(rotated.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
    expect(rotated.secret).not.toBe(created.secret);
    expect(JSON.stringify(rotated.webhook)).not.toContain(rotated.secret);

    const updated = await service().update({
      principal: freshPrincipal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
      webhookId: created.webhook.id,
      events: ["note.updated"],
    });
    const updatedText = JSON.stringify(updated);
    expect(updatedText).not.toContain(created.secret);
    expect(updatedText).not.toContain(rotated.secret);

    // The verification challenge signs with the secret and must not echo it.
    const verified = await service().verify({
      principal: freshPrincipal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
      webhookId: (await registerEndpoint(await startEchoReceiver())).webhook.id,
    });
    expect(verified.isVerified).toBe(true);
    expect(JSON.stringify(verified)).not.toContain(WEBHOOK_SECRET_PREFIX);

    // And neither read path over real HTTP carries it.
    const list = await request(server())
      .get(WEBHOOK_API_PATHS.collection(ALPHA))
      .set("Authorization", bearer(adminKey))
      .expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.text).not.toContain(created.secret);
    expect(list.text).not.toContain(rotated.secret);
    expect(list.text).not.toContain(WEBHOOK_SECRET_PREFIX);

    const deliveries = await request(server())
      .get(WEBHOOK_API_PATHS.deliveries(ALPHA, created.webhook.id))
      .set("Authorization", bearer(adminKey))
      .expect(200);
    expect(deliveries.text).not.toContain(rotated.secret);
    expect(deliveries.text).not.toContain(WEBHOOK_SECRET_PREFIX);
  });

  // ------------------------------------------------------------------ //
  // Lifecycle invariants.
  // ------------------------------------------------------------------ //

  it("refuses to enable an unverified endpoint", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();
    expect(webhook.isVerified).toBe(false);
    expect(webhook.isEnabled).toBe(false);

    await expect(
      service().update({
        principal: freshPrincipal(SEED_IDS.users.alphaOwner),
        workspaceId: ALPHA,
        requestId: null,
        webhookId: webhook.id,
        isEnabled: true,
      }),
    ).rejects.toMatchObject({ safeResponse: { code: "WEBHOOK_NOT_VERIFIED" } });
  });

  it("resets verification and enablement when the destination URL changes", async () => {
    if (!live) return;
    const database = db as NodePgDatabase<typeof schema>;
    const { webhook } = await registerEndpoint();
    await database
      .update(webhooks)
      .set({ isVerified: true, isEnabled: true })
      .where(eq(webhooks.id, webhook.id));

    const moved = await service().update({
      principal: freshPrincipal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
      webhookId: webhook.id,
      url: LOOPBACK("moved"),
    });
    // A MOVED ENDPOINT IS A NEW ENDPOINT: verification proved that the OLD host
    // controls the secret and proves nothing about the next one.
    expect(moved).toMatchObject({ url: LOOPBACK("moved"), isVerified: false, isEnabled: false });

    const [row] = await database
      .select({ isVerified: webhooks.isVerified, isEnabled: webhooks.isEnabled })
      .from(webhooks)
      .where(eq(webhooks.id, webhook.id));
    expect(row).toEqual({ isVerified: false, isEnabled: false });
  });

  it("caps a workspace at ten endpoints", async () => {
    if (!live) return;
    const database = db as NodePgDatabase<typeof schema>;
    for (let index = 0; index < WEBHOOK_ENDPOINT_LIMIT; index += 1) {
      await registerEndpoint(LOOPBACK(`cap-${index}`));
    }
    const before = await database
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ALPHA));
    expect(before).toHaveLength(WEBHOOK_ENDPOINT_LIMIT);

    await expect(registerEndpoint(LOOPBACK("cap-overflow"))).rejects.toMatchObject({
      safeResponse: { code: "CONFLICT" },
    });
    // The refusal is counted inside the transaction, so nothing landed.
    const after = await database
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ALPHA));
    expect(after).toHaveLength(WEBHOOK_ENDPOINT_LIMIT);
  });

  // ------------------------------------------------------------------ //
  // Validation happens before anything is written.
  // ------------------------------------------------------------------ //

  it("rejects a malformed URL, an empty event list and an unknown event before any write", async () => {
    if (!live) return;
    const database = db as NodePgDatabase<typeof schema>;
    const before = await database
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ALPHA));

    // `webhookCreateSchema` IS the controller's gate — `WebhooksController.create`
    // answers 400 `VALIDATION_ERROR` the moment `safeParse` fails, before the
    // service, the SSRF guard and the transaction are ever reached. The gate is
    // asserted here rather than over HTTP because `POST /webhooks` is
    // `webhook.create`, a HIGH_RISK action no API key can reach (see the file
    // header), so no credential this suite can mint gets past the guard to the
    // body parse.
    for (const body of [
      { url: "not-a-url", events: ["note.created"] },
      { url: LOOPBACK("valid"), events: [] },
      { url: LOOPBACK("valid"), events: ["note.exploded"] },
      { url: "https://user:pass@receiver.example.test/hook", events: ["note.created"] },
    ]) {
      expect(webhookCreateSchema.safeParse(body).success).toBe(false);
    }

    const after = await database
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ALPHA));
    expect(after).toHaveLength(before.length);
  });

  it("answers 400 VALIDATION_ERROR for an out-of-range page size and an unknown status filter", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();

    const overLimit = await request(server())
      .get(WEBHOOK_API_PATHS.collection(ALPHA))
      .query({ limit: "999" })
      .set("Authorization", bearer(adminKey));
    expect(overLimit.status).toBe(400);
    expect(overLimit.body.error.code).toBe("VALIDATION_ERROR");

    const badStatus = await request(server())
      .get(WEBHOOK_API_PATHS.deliveries(ALPHA, webhook.id))
      .query({ status: "exploded" })
      .set("Authorization", bearer(adminKey));
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ------------------------------------------------------------------ //
  // API-key access: scope decides at the guard, the creator's role and the
  // freshness gate decide at the service.
  // ------------------------------------------------------------------ //

  it("lets an admin-scoped key read the endpoint list and the delivery log", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();

    const list = await request(server())
      .get(WEBHOOK_API_PATHS.collection(ALPHA))
      .set("Authorization", bearer(adminKey))
      .expect(200);
    // ADR 0013: success payloads are bare; only errors carry the envelope.
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(webhook.id);

    const deliveries = await request(server())
      .get(WEBHOOK_API_PATHS.deliveries(ALPHA, webhook.id))
      .set("Authorization", bearer(adminKey))
      .expect(200);
    expect(deliveries.body.items).toEqual([]);

    // `webhook.redeliver` is not a HIGH_RISK action, so the key really does get
    // through authorization — and then meets an honest 404 for a delivery that
    // does not exist. That 404 is what distinguishes it from the editor's 403.
    const retry = await request(server())
      .post(WEBHOOK_API_PATHS.retryDelivery(ALPHA, webhook.id, randomUUID()))
      .set("Authorization", bearer(adminKey));
    expect(retry.status).toBe(404);
    expect(retry.body.error.code).toBe("NOT_FOUND");
  });

  it("denies a read-scoped key on the admin-only webhook surface", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();

    for (const path of [
      WEBHOOK_API_PATHS.collection(ALPHA),
      WEBHOOK_API_PATHS.deliveries(ALPHA, webhook.id),
    ]) {
      const response = await request(server()).get(path).set("Authorization", bearer(readKey));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  /**
   * SHIPPED BEHAVIOUR, ASSERTED SO IT CANNOT CHANGE BY ACCIDENT. Every webhook
   * mutation is a HIGH_RISK action and every API key is `isFresh: false`, so no
   * integration can register, re-point, delete, re-key or verify an endpoint —
   * only a human on a recently authenticated session can. If that is ever meant
   * to change it has to change here first.
   */
  it("closes every webhook mutation to API keys because a machine credential is never fresh", async () => {
    if (!live) return;
    const { webhook } = await registerEndpoint();
    const mutations = allRoutes(ALPHA, webhook.id, randomUUID()).filter((route) =>
      [
        "POST collection",
        "PATCH detail",
        "DELETE detail",
        "POST rotate-secret",
        "POST verify",
      ].includes(route.name),
    );
    expect(mutations).toHaveLength(5);

    for (const route of mutations) {
      const response = await call(route, adminKey);
      expect({ route: route.name, status: response.status }).toEqual({
        route: route.name,
        status: 403,
      });
      expect(response.body.error.code).toBe("RECENT_AUTHENTICATION_REQUIRED");
    }
  });
});
