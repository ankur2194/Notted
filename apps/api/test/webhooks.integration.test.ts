// Part 66 — the outbound webhook delivery pipeline against a live PostgreSQL
// and real in-process HTTP receivers.
//
// Same shape as `export.integration.test.ts`: self-provisioning (`migrate` +
// `seedDatabase`), self-skipping when no reachable `DATABASE_URL` is
// configured, and every collaborator constructed BY HAND rather than through
// the Nest container — so this exercises the real SQL, the real policies, the
// real signing and the real socket without booting the application graph.
//
// NO REDIS AND NO BULLMQ LOOP. The producer/worker split is proved the way
// `export.integration.test.ts` proves its own: by reading the `job_outbox` row
// the producer wrote INSIDE the note transaction and then invoking
// `WebhookDeliveryWorkerService.handle` directly with a hand-built
// `QueueJobContext`. The outbox row IS the contract between the two halves, and
// `context.attempt` is what BullMQ would otherwise supply.
//
// RECEIVERS ARE IN-PROCESS `node:http` SERVERS ON 127.0.0.1, NEVER CONTAINERS.
// The api container sits on the `backend` + `edge` networks only and cannot
// reach an arbitrary host port, so a containerised receiver would be
// unreachable from the code under test. Every server binds with `listen(0)` for
// an ephemeral port and is closed in `afterEach` with `closeAllConnections()` —
// one lingering keep-alive socket hangs the whole file.
//
// WHY `WEBHOOK_ALLOW_INSECURE_URLS` IS TURNED ON HERE, AND WHY THAT PROVES
// SOMETHING RATHER THAN HIDING IT: the flag unblocks EXACTLY TWO things, the
// `http:` scheme and LOOPBACK addresses. `10/8`, `172.16/12`, `192.168/16` and
// `169.254/16` (the cloud metadata address lives there) stay blocked with the
// flag ON — which is why "private/local IP destinations are rejected" is
// asserted in the SAME run as a working 127.0.0.1 delivery. The guard is never
// weakened to make a test pass.

import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { allowAuditDelete } from "../src/audit/audit-record";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { VerifiedHostsService } from "../src/common/verified-hosts.service";
import { parseSecurityConfig } from "../src/config/security.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  auditLogs,
  jobOutbox,
  notes,
  projects,
  schema,
  webhookDeliveries,
  webhooks,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { NoteVersionsService } from "../src/notes/note-versions.service";
import { NotesService } from "../src/notes/notes.service";
import { DOMAIN_JOB_TYPES } from "../src/queue/job-identifiers";
import { WEBHOOK_DELIVER_JOB_DEFINITION } from "../src/queue/job-registry";
import { TenantContextService } from "../src/tenant";
import { WebhookDeliveryProducer } from "../src/webhooks/webhook-delivery.producer";
import { WebhookDeliveryWorkerService } from "../src/webhooks/webhook-delivery.worker.service";
import { WebhookSecretService } from "../src/webhooks/webhook-secret.service";
import {
  WEBHOOK_MAXIMUM_ATTEMPTS,
  WEBHOOK_SNIPPET_MAX_LENGTH,
} from "../src/webhooks/webhooks.constants";
import { WebhooksService } from "../src/webhooks/webhooks.service";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AppConfig } from "../src/config/app.config";
import type { QueueHandlerRegistry } from "../src/queue/queue-handler-registry.service";
import type { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import type { AuthenticatedPrincipal, WebhookEvent } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const ALPHA = SEED_IDS.workspaces.alpha;

/**
 * The real config parser, not a hand-rolled object literal: the flag name and
 * its narrow meaning are exactly what is under test in the SSRF case, and a
 * literal would let this suite drift away from `security.config.ts` silently.
 * The 1s request timeout is the parser's own minimum, which keeps the
 * "receiver never answers" case to about a second of wall clock.
 */
const SECURITY = parseSecurityConfig({
  NODE_ENV: "test",
  WEBHOOK_ALLOW_INSECURE_URLS: "true",
  WEBHOOK_REQUEST_TIMEOUT_MS: "1000",
});

/**
 * `selfHostnames` comes from these two, so they must NOT be loopback — an
 * endpoint pointing at our own hostname is refused by L3, and that rule must
 * not accidentally swallow the 127.0.0.1 receivers.
 */
const APP = {
  appUrl: new URL("https://app.notted.test"),
  apiUrl: new URL("https://api.notted.test"),
} as AppConfig;

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `webhooks:${userId}`,
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    // `webhook.create` and `webhook.update` are HIGH_RISK_ACTIONS, so a stale
    // principal would be denied before any webhook logic ran.
    isFresh: true,
  });
}

/**
 * Bounded polling with a deadline, never a bare sleep. Same shape as
 * `eventually` in `realtime.integration.test.ts`; it is duplicated rather than
 * shared because the repository has no cross-suite test helper for it and
 * `database-test-helpers.ts` is deliberately schema-only.
 */
async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("Condition was not reached before the deadline");
}

interface ReceivedRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  /** Every request this receiver actually accepted, in arrival order. */
  readonly requests: readonly ReceivedRequest[];
}

const servers: Server[] = [];

async function closeServer(server: Server): Promise<void> {
  // A receiver that never answered still holds an open socket; without this the
  // suite hangs on `close` instead of failing.
  server.closeAllConnections();
  await new Promise<void>((done) => {
    server.close(() => done());
  });
}

/**
 * One in-process receiver. `respond` is called once per request with the
 * 1-based request number, so a handler can answer differently on a retry.
 * Passing a handler that never touches `response` is how "the receiver accepts
 * the connection and never answers" is expressed.
 */
async function startReceiver(
  respond: (request: ReceivedRequest, response: ServerResponse, attempt: number) => void,
): Promise<Receiver> {
  const requests: ReceivedRequest[] = [];
  const server = createServer((incoming, response) => {
    // A body we stopped reading (the 8 KB cap) closes the socket under the
    // server's feet; an unhandled 'error' there would crash the whole file.
    incoming.on("error", () => undefined);
    response.on("error", () => undefined);
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const received: ReceivedRequest = {
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(received);
      respond(received, response, requests.length);
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
  return { url: `http://127.0.0.1:${address.port}/hook`, requests };
}

interface CapturedLog {
  readonly level: "info" | "warning" | "failure";
  readonly metadata: unknown;
  readonly message: string;
}

function build(db: NodePgDatabase<typeof schema>) {
  const tenant = new TenantContextService();
  const database = {
    db,
    transaction: <T>(
      work: (scope: DatabaseTransaction) => Promise<T>,
      config?: PgTransactionConfig,
    ) => db.transaction(work, config),
  } as unknown as DatabaseService;
  const logs: CapturedLog[] = [];
  const logger = {
    info: (metadata: unknown, message: string) => logs.push({ level: "info", metadata, message }),
    warning: (metadata: unknown, message: string) =>
      logs.push({ level: "warning", metadata, message }),
    failure: (metadata: unknown, message: string) =>
      logs.push({ level: "failure", metadata, message }),
    warn: () => undefined,
  } as unknown as StructuredLogger;
  const authorization = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  // Custom domains are off in this fixture, so no hostname is a tenant host.
  const NO_VERIFIED_HOSTS = {
    isVerifiedTenantHost: () => Promise.resolve(false),
  } as unknown as VerifiedHostsService;
  const secrets = new WebhookSecretService(SECURITY);
  const producer = new WebhookDeliveryProducer(tenant);
  return {
    tenant,
    logs,
    webhooksService: new WebhooksService(
      database,
      authorization,
      tenant,
      secrets,
      producer,
      APP,
      SECURITY,
      NO_VERIFIED_HOSTS,
    ),
    notesService: new NotesService(
      database,
      authorization,
      tenant,
      { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
      new NoteVersionsService(tenant),
      undefined,
      undefined,
      undefined,
      // The ninth argument, and the whole point: the producer runs inside the
      // note-mutation transaction.
      producer,
    ),
    worker: new WebhookDeliveryWorkerService(
      database,
      authorization,
      tenant,
      secrets,
      { register: () => () => undefined } as unknown as QueueHandlerRegistry,
      logger,
      APP,
      SECURITY,
      NO_VERIFIED_HOSTS,
    ),
  };
}

type Harness = ReturnType<typeof build>;

interface OutboxIntent {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
}

/** Every `webhook.deliver` intent addressed to one endpoint, oldest first. */
async function intentsFor(
  scope: NodePgDatabase<typeof schema>,
  webhookId: string,
): Promise<OutboxIntent[]> {
  const rows = await scope
    .select({
      id: jobOutbox.id,
      idempotencyKey: jobOutbox.idempotencyKey,
      payload: jobOutbox.payload,
      createdAt: jobOutbox.createdAt,
    })
    .from(jobOutbox)
    .where(eq(jobOutbox.jobType, DOMAIN_JOB_TYPES.webhookDeliver));
  return rows
    .filter((row) => (row.payload as unknown as { webhookId?: string }).webhookId === webhookId)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map(({ id, idempotencyKey, payload }) => ({ id, idempotencyKey, payload }));
}

/** The envelope BullMQ would hand the handler for `intent` on `attempt`. */
function deliverContext(intent: OutboxIntent, attempt = 1) {
  return {
    outboxIntentId: intent.id,
    jobType: WEBHOOK_DELIVER_JOB_DEFINITION.jobType,
    idempotencyKey: intent.idempotencyKey,
    payload: WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema.parse(intent.payload),
    signal: new AbortController().signal,
    attempt,
    maximumAttempts: WEBHOOK_DELIVER_JOB_DEFINITION.maximumAttempts ?? WEBHOOK_MAXIMUM_ATTEMPTS,
  };
}

/**
 * `handle` legitimately either resolves (terminal outcome recorded) or throws
 * (asks BullMQ for the next backoff). Both are results, so both are captured
 * rather than one being treated as a failure of the test.
 */
async function drive(
  harness: Harness,
  scope: NodePgDatabase<typeof schema>,
  intent: OutboxIntent,
  attempt = 1,
): Promise<"settled" | "threw"> {
  // CLAIM THE INTENT FIRST, exactly as the real dispatcher would. These tests
  // run against the shared development database, and a development API
  // container polling `job_outbox` on its own interval would otherwise claim
  // this same intent and deliver it a second time — from inside the container,
  // where the test's `127.0.0.1` receiver does not exist, so it lands in
  // `webhook_deliveries` as a phantom extra attempt with the same event id and
  // payload hash but a `connection_failed` code. A terminal status is never
  // re-claimed, so this makes the test the only deliverer of its own intent.
  await scope
    .update(jobOutbox)
    .set({ status: "completed", dispatchedAt: new Date(), completedAt: new Date() })
    .where(eq(jobOutbox.id, intent.id));
  return harness.worker.handle(deliverContext(intent, attempt)).then(
    () => "settled" as const,
    () => "threw" as const,
  );
}

async function deliveriesFor(scope: NodePgDatabase<typeof schema>, webhookId: string) {
  const rows = await scope
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId));
  return rows.sort((left, right) => left.attempt - right.attempt);
}

const header = (request: ReceivedRequest, name: string): string => {
  const value = request.headers[name];
  return typeof value === "string" ? value : "";
};

describe.skipIf(!HAS_DATABASE)("Part 66 webhook delivery pipeline (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  // Everything this file commits, so each test leaves the tenant as it found it.
  const createdWebhookIds: string[] = [];
  const createdNoteIds: string[] = [];

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.transaction(async (tx) => seedDatabase(tx));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await closeServer(server);
    if (db === undefined) return;
    for (const noteId of createdNoteIds.splice(0)) {
      await db.delete(notes).where(eq(notes.id, noteId));
    }
    for (const webhookId of createdWebhookIds.splice(0)) {
      // The append-only trigger (migration 0021) refuses this DELETE unless
      // `notted.audit_purge` is set for the transaction.
      await db.transaction(async (tx) => {
        await allowAuditDelete(tx);
        await tx.delete(auditLogs).where(eq(auditLogs.entityId, webhookId));
      });
      // `webhook_deliveries.webhook_id` cascades, so the attempt rows go too.
      await db.delete(webhooks).where(eq(webhooks.id, webhookId));
    }
    await db.delete(jobOutbox).where(eq(jobOutbox.jobType, DOMAIN_JOB_TYPES.webhookDeliver));
    // A restricted-project case may have flipped this; the seed default is false.
    await db
      .update(projects)
      .set({ isRestricted: false })
      .where(eq(projects.id, SEED_IDS.projects.alphaOperations));
  });

  afterAll(async () => pool?.end());

  /**
   * Minted PER CALL, never once at collection time: `expiresAt` is enforced by
   * the policy, and a principal frozen when the file was loaded would start
   * failing as `expired_principal` partway through a slow run.
   */
  const owner = (): AuthenticatedPrincipal => principal(SEED_IDS.users.alphaOwner);

  /** A registered endpoint. It arrives DISABLED and UNVERIFIED, as the service insists. */
  async function createEndpoint(
    harness: Harness,
    url: string,
    events: readonly WebhookEvent[] = ["note.created"],
  ) {
    const created = await harness.webhooksService.create({
      principal: owner(),
      workspaceId: ALPHA,
      requestId: null,
      url,
      events,
    });
    createdWebhookIds.push(created.webhook.id);
    return created;
  }

  /**
   * Marks an endpoint live WITHOUT running the challenge. The challenge has its
   * own two tests below; forcing the columns here keeps the delivery tests
   * about delivery, and it is the one shortcut this file takes.
   */
  async function makeLive(scope: NodePgDatabase<typeof schema>, webhookId: string): Promise<void> {
    await scope
      .update(webhooks)
      .set({ isVerified: true, isEnabled: true })
      .where(eq(webhooks.id, webhookId));
  }

  async function createNote(harness: Harness, projectId: string | null = null): Promise<string> {
    const suffix = randomUUID();
    const created = await harness.notesService.create({
      principal: owner(),
      workspaceId: ALPHA,
      title: `Webhook source ${suffix}`,
      projectId,
      folderId: null,
      parentId: null,
      type: "document",
      pageSize: "a4",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: `Body ${suffix}` }] }],
      },
      idempotencyKey: `webhook-fixture-${suffix}`,
    });
    createdNoteIds.push(created.note.id);
    return created.note.id;
  }

  // ------------------------------------------------------------------ //
  // "Receiver timeouts do not block application writes."
  // ------------------------------------------------------------------ //

  it("commits the note while a silent receiver is still holding the delivery open", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    // Accepts the connection, reads the body, and NEVER answers.
    const receiver = await startReceiver(() => undefined);
    const { webhook } = await createEndpoint(harness, receiver.url);
    await makeLive(db, webhook.id);

    const noteId = await createNote(harness);

    // THE CLAUSE, stated structurally rather than as a stopwatch: the write
    // path never opened a socket at all, so it cannot have waited on one — and
    // the note is durable before any delivery is attempted.
    expect(receiver.requests).toHaveLength(0);
    const [committed] = await db.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId));
    expect(committed?.id).toBe(noteId);

    const [intent] = await intentsFor(db, webhook.id);
    expect(intent).toBeDefined();

    // Now drive the delivery and hold it in flight against the silent receiver.
    const inFlight = drive(harness, db, intent as OutboxIntent);
    await eventually(() => receiver.requests.length === 1);
    // Still committed and still readable while the socket hangs open.
    const [duringDelivery] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.id, noteId));
    expect(duringDelivery?.id).toBe(noteId);

    // A timeout is retryable, so attempt 1 of 5 asks for the next backoff.
    expect(await inFlight).toBe("threw");
    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status: "retrying",
      errorMessage: "timeout",
      responseStatus: null,
      responseBodySnippet: null,
    });
  });

  // ------------------------------------------------------------------ //
  // "Retries are idempotent."
  // ------------------------------------------------------------------ //

  it("retries one event under one stable event id, one outbox intent and two delivery ids", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const receiver = await startReceiver((_request, response, attempt) => {
      response.writeHead(attempt === 1 ? 500 : 200, { "content-type": "text/plain" });
      response.end(attempt === 1 ? "boom" : "ok");
    });
    const { webhook } = await createEndpoint(harness, receiver.url);
    await makeLive(db, webhook.id);
    await createNote(harness);

    const intents = await intentsFor(db, webhook.id);
    expect(intents).toHaveLength(1);
    const intent = intents[0] as OutboxIntent;

    expect(await drive(harness, db, intent, 1)).toBe("threw");
    expect(await drive(harness, db, intent, 2)).toBe("settled");

    // THE RECEIVER'S DEDUPE KEY IS STABLE; THE ATTEMPT'S IDENTITY IS NOT.
    expect(receiver.requests).toHaveLength(2);
    const first = receiver.requests[0] as ReceivedRequest;
    const second = receiver.requests[1] as ReceivedRequest;
    expect(header(first, "x-notted-event-id")).toBe(header(second, "x-notted-event-id"));
    expect(header(first, "x-notted-event-id")).not.toBe("");
    expect(header(first, "x-notted-delivery-id")).not.toBe(header(second, "x-notted-delivery-id"));

    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts.map((row) => [row.attempt, row.status])).toEqual([
      [1, "retrying"],
      [2, "success"],
    ]);
    // Both rows are the SAME logical event, and the receiver was told so.
    expect(new Set(attempts.map((row) => row.eventId)).size).toBe(1);
    expect(attempts[0]?.eventId).toBe(header(first, "x-notted-event-id"));
    // A retry is a re-send of one durable intent, never a second intent.
    expect(await intentsFor(db, webhook.id)).toHaveLength(1);
  });

  // ------------------------------------------------------------------ //
  // Manual replay after a terminal failure.
  // ------------------------------------------------------------------ //

  it("replays a failed delivery under the same event id with a fresh intent and attempt 1", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    // 404 is terminal: retrying it would just re-receive the same 404.
    const receiver = await startReceiver((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("gone");
    });
    const { webhook } = await createEndpoint(harness, receiver.url);
    await makeLive(db, webhook.id);
    await createNote(harness);

    const [original] = await intentsFor(db, webhook.id);
    expect(await drive(harness, db, original as OutboxIntent, 1)).toBe("settled");
    const [failed] = await deliveriesFor(db, webhook.id);
    expect(failed).toMatchObject({ attempt: 1, status: "failed", errorMessage: "http_error" });

    // The service call the `POST .../deliveries/:deliveryId/retry` route makes.
    const replay = await harness.webhooksService.retryDelivery({
      principal: owner(),
      workspaceId: ALPHA,
      requestId: null,
      webhookId: webhook.id,
      deliveryId: (failed as { id: string }).id,
    });
    expect(replay).toMatchObject({
      webhookId: webhook.id,
      eventId: (failed as { eventId: string }).eventId,
      scheduled: true,
    });

    // A SECOND intent, with a NEW id, carrying the ORIGINAL event id.
    const intents = await intentsFor(db, webhook.id);
    expect(intents).toHaveLength(2);
    const replayed = intents[1] as OutboxIntent;
    expect(replayed.id).not.toBe((original as OutboxIntent).id);
    const replayedPayload = replayed.payload as { eventId: string; intentId: string };
    expect(replayedPayload.eventId).toBe((failed as { eventId: string }).eventId);
    expect(replayedPayload.intentId).toBe(replayed.id);

    // A replay is a fresh job, so its attempt numbering starts over at 1.
    expect(await drive(harness, db, replayed, 1)).toBe("settled");
    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((row) => row.attempt)).toEqual([1, 1]);
    expect(new Set(attempts.map((row) => row.eventId)).size).toBe(1);
  });

  // ------------------------------------------------------------------ //
  // "Private/local IP destinations are rejected" — in the SAME run as an
  // accepted loopback receiver. That contrast is the whole point of the flag's
  // narrow scope.
  // ------------------------------------------------------------------ //

  it("refuses private, link-local and metadata destinations while accepting loopback", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    expect(SECURITY.webhookAllowInsecureUrls).toBe(true);

    for (const url of [
      "http://10.0.0.1/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/hook",
      "http://172.16.0.1/hook",
    ]) {
      await expect(
        harness.webhooksService.create({
          principal: owner(),
          workspaceId: ALPHA,
          requestId: null,
          url,
          events: ["note.created"],
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "WEBHOOK_URL_REJECTED" } });
    }
    // Not one of them left a row behind.
    const rows = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ALPHA));
    expect(rows).toHaveLength(0);

    const receiver = await startReceiver((_request, response) => {
      response.end();
    });
    const { webhook } = await createEndpoint(harness, receiver.url);
    expect(webhook.url).toBe(receiver.url);
    expect(webhook.isEnabled).toBe(false);
    expect(webhook.isVerified).toBe(false);
  });

  // ------------------------------------------------------------------ //
  // L7 — a 3xx is DATA. The sender never follows it.
  // ------------------------------------------------------------------ //

  it("never follows a redirect and records the 302 as a permanent failure", async ({ skip }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const secondary = await startReceiver((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("the redirect was followed");
    });
    const redirecting = await startReceiver((_request, response) => {
      response.writeHead(302, { location: secondary.url, "content-type": "text/plain" });
      response.end("moved");
    });
    const { webhook } = await createEndpoint(harness, redirecting.url);
    await makeLive(db, webhook.id);
    await createNote(harness);

    const [intent] = await intentsFor(db, webhook.id);
    // Terminal, not retried: five more attempts would collect five more 302s.
    expect(await drive(harness, db, intent as OutboxIntent, 1)).toBe("settled");

    expect(redirecting.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(0);
    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      errorMessage: "http_error",
      responseStatus: 302,
    });
  });

  // ------------------------------------------------------------------ //
  // L8 — bounded, sanitized response capture.
  // ------------------------------------------------------------------ //

  it("caps a chatty receiver's stored snippet and stores none for a binary body", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    // No `content-length`, so this streams: the cap has to hold on the wire,
    // not just on a declared header.
    const chatty = await startReceiver((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      for (let written = 0; written < 40; written += 1) response.write("a".repeat(512));
      response.end();
    });
    const binary = await startReceiver((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("not text at all");
    });

    const chattyEndpoint = await createEndpoint(harness, chatty.url);
    await makeLive(db, chattyEndpoint.webhook.id);
    const binaryEndpoint = await createEndpoint(harness, binary.url);
    await makeLive(db, binaryEndpoint.webhook.id);
    await createNote(harness);

    const [chattyIntent] = await intentsFor(db, chattyEndpoint.webhook.id);
    const [binaryIntent] = await intentsFor(db, binaryEndpoint.webhook.id);
    expect(await drive(harness, db, chattyIntent as OutboxIntent)).toBe("settled");
    expect(await drive(harness, db, binaryIntent as OutboxIntent)).toBe("settled");

    const [chattyAttempt] = await deliveriesFor(db, chattyEndpoint.webhook.id);
    // A 200 is a successful delivery however chatty the receiver is; only the
    // stored evidence is bounded.
    expect(chattyAttempt).toMatchObject({ status: "success", responseStatus: 200 });
    expect(chattyAttempt?.responseBodySnippet).toHaveLength(WEBHOOK_SNIPPET_MAX_LENGTH);

    const [binaryAttempt] = await deliveriesFor(db, binaryEndpoint.webhook.id);
    expect(binaryAttempt).toMatchObject({
      status: "success",
      responseStatus: 200,
      responseBodySnippet: null,
    });
  });

  // ------------------------------------------------------------------ //
  // The verification challenge — the one outbound call on a request thread.
  // ------------------------------------------------------------------ //

  it("verifies an endpoint that echoes the challenge and records the attempt", async ({ skip }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const receiver = await startReceiver((request, response) => {
      const challenge = (JSON.parse(request.body) as { data: { challenge: string } }).data
        .challenge;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(challenge);
    });
    const { webhook } = await createEndpoint(harness, receiver.url);

    const verified = await harness.webhooksService.verify({
      principal: owner(),
      workspaceId: ALPHA,
      requestId: null,
      webhookId: webhook.id,
    });
    expect(verified.isVerified).toBe(true);
    expect(verified.webhook.isVerified).toBe(true);
    // Verified is not enabled: enabling stays a separate, deliberate act.
    expect(verified.webhook.isEnabled).toBe(false);

    const [row] = await db
      .select({ isVerified: webhooks.isVerified })
      .from(webhooks)
      .where(eq(webhooks.id, webhook.id));
    expect(row?.isVerified).toBe(true);

    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      event: "webhook.verification",
      status: "success",
      attempt: 1,
      responseStatus: 200,
    });
    expect(attempts[0]?.id).toBe(verified.delivery.id);
  });

  it("fails verification on a 2xx without the challenge and still writes the attempt", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const receiver = await startReceiver((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("thanks, but I am not echoing anything");
    });
    const { webhook } = await createEndpoint(harness, receiver.url);

    await expect(
      harness.webhooksService.verify({
        principal: owner(),
        workspaceId: ALPHA,
        requestId: null,
        webhookId: webhook.id,
      }),
    ).rejects.toMatchObject({ safeResponse: { code: "WEBHOOK_VERIFICATION_FAILED" } });

    const [row] = await db
      .select({ isVerified: webhooks.isVerified })
      .from(webhooks)
      .where(eq(webhooks.id, webhook.id));
    expect(row?.isVerified).toBe(false);

    // THE FAILURE IS IN THE HISTORY. It is written outside any transaction on
    // purpose, so the 422 cannot roll away the only evidence the admin needs.
    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      event: "webhook.verification",
      status: "failed",
      errorMessage: "http_error",
      responseStatus: 200,
    });
  });

  // ------------------------------------------------------------------ //
  // The creator-scope leak guard — the security-critical case.
  // ------------------------------------------------------------------ //

  it("never contacts the receiver when the endpoint's creator cannot read the note", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const receiver = await startReceiver((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("this must never be reached");
    });
    const { webhook } = await createEndpoint(harness, receiver.url);
    // The endpoint belongs to an EDITOR with no grant on the restricted
    // project. `createEndpoint` runs as the owner (only an admin may register
    // one), so the creator is re-pointed here — the worker re-authorizes
    // `created_by_id`, not whoever happened to trigger the event.
    await db
      .update(webhooks)
      .set({ createdById: SEED_IDS.users.alphaEditor, isVerified: true, isEnabled: true })
      .where(eq(webhooks.id, webhook.id));
    await db
      .update(projects)
      .set({ isRestricted: true })
      .where(eq(projects.id, SEED_IDS.projects.alphaOperations));

    // The owner can still file a note there; the editor still cannot read it.
    await createNote(harness, SEED_IDS.projects.alphaOperations);

    const [intent] = await intentsFor(db, webhook.id);
    expect(intent).toBeDefined();
    expect(await drive(harness, db, intent as OutboxIntent, 1)).toBe("settled");

    // NOT ONE BYTE LEFT THE PROCESS.
    expect(receiver.requests).toHaveLength(0);
    const attempts = await deliveriesFor(db, webhook.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      errorMessage: "resource_forbidden",
      responseStatus: null,
      payloadHash: null,
      deliveredAt: null,
    });
  });

  // ------------------------------------------------------------------ //
  // Redaction: the URL, the signature and the secret are never durable.
  // ------------------------------------------------------------------ //

  it("keeps the endpoint URL, the signature header and the secret out of rows and logs", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const receiver = await startReceiver((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    const { webhook, secret } = await createEndpoint(harness, receiver.url);
    await makeLive(db, webhook.id);
    await createNote(harness);

    const [intent] = await intentsFor(db, webhook.id);
    expect(await drive(harness, db, intent as OutboxIntent, 1)).toBe("settled");
    expect(receiver.requests).toHaveLength(1);
    const signature = header(receiver.requests[0] as ReceivedRequest, "x-notted-signature");
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/u);

    // Non-vacuous: there really is an attempt row and there really is a log line.
    const rows = await deliveriesFor(db, webhook.id);
    expect(rows).toHaveLength(1);
    expect(harness.logs.length).toBeGreaterThan(0);
    const serializedRows = JSON.stringify(rows);
    const serializedLogs = JSON.stringify(harness.logs);

    for (const forbidden of [receiver.url, signature, secret]) {
      expect(serializedRows).not.toContain(forbidden);
      expect(serializedLogs).not.toContain(forbidden);
    }
    // The audit trail keeps the hostname only, never the path or the secret.
    const audits = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, webhook.id));
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(secret);
    expect(serializedAudits).not.toContain(receiver.url);
  });
});
