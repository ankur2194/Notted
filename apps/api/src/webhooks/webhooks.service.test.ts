// Part 66 — unit tests for the webhooks application service.
//
// WHAT THIS SUITE IS FOR. Three properties of `webhooks.service.ts` are
// security properties rather than features, and none of them fails loudly when
// it regresses:
//
//   1. TENANT SCOPE. The fake database below enforces nothing, so a deleted
//      `whereWorkspace(...)` would leave every behavioural assertion green
//      while a foreign workspace's endpoint became readable, editable and
//      replayable. `scopesToWorkspace` therefore renders the captured
//      predicate to real SQL and checks the workspace condition is in it —
//      the same technique `api-keys.service.test.ts` uses, for the same reason.
//   2. THE SECRET PROJECTION. `encryptedSecret` must be absent from the read
//      selection BY CONSTRUCTION. The fixture rows here deliberately CARRY a
//      ciphertext the service never asked for, so any DTO that echoes a row
//      instead of building one fails these tests.
//   3. THE VERIFICATION ORDER. A failed verification answers 422 but must
//      still leave the attempt in the delivery history first, which is the one
//      place an admin looks when their endpoint will not verify.
//
// The sender and the DNS layer are stubbed: no socket and no resolver is
// touched. `inspectWebhookUrl` stays REAL, so the syntax-level rejections
// asserted here are the production guard's own verdicts.

import {
  WEBHOOK_ENDPOINT_LIMIT,
  WEBHOOK_VERIFICATION_EVENT,
  type AuthenticatedPrincipal,
} from "@notted/shared-types";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { auditLogs, jobOutbox, webhookDeliveries, webhooks } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import { createTenantContext, TenantContextService } from "../tenant";

import { sendWebhook, type WebhookSendRequest } from "./webhook-sender";
import { verifyWebhookSignature } from "./webhook-signature";
import { resolveWebhookHost } from "./webhook-url-guard";
import { WEBHOOK_AUDIT_ACTIONS, WEBHOOK_AUDIT_ENTITY_TYPE } from "./webhooks.constants";
import { WebhooksService } from "./webhooks.service";

import type { WebhookDeliveryProducer } from "./webhook-delivery.producer";
import type { WebhookSecretService } from "./webhook-secret.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { VerifiedHostsService } from "../common/verified-hosts.service";
import type { AppConfig } from "../config/app.config";
import type { SecurityConfig } from "../config/security.config";
import type { DatabaseService } from "../database/database.service";

vi.mock("./webhook-sender", () => ({ sendWebhook: vi.fn() }));

// PARTIAL mock: only the DNS layer is replaced. `inspectWebhookUrl` (L1–L3) is
// the real implementation, so "a `http://` URL is refused" is proven by the
// shipped guard rather than by a stub that agrees with the test.
vi.mock("./webhook-url-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook-url-guard")>()),
  resolveWebhookHost: vi.fn(),
}));

const sent = vi.mocked(sendWebhook);
const resolveHost = vi.mocked(resolveWebhookHost);

const USER_ID = "60000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "60000000-0000-4000-8100-000000000001";
const WEBHOOK_ID = "60000000-0000-4000-8200-000000000001";
const DELIVERY_ID = "60000000-0000-4000-8300-000000000001";
const EVENT_ID = "60000000-0000-4000-8400-000000000001";
const INTENT_ID = "60000000-0000-4000-8500-000000000001";
const NOTE_ID = "60000000-0000-4000-8600-000000000001";

const SECRET = "whsec_0123456789012345678901234567890123456789012";
/** A verified custom domain of another workspace, served by this deployment. */
const TENANT_HOST = "b.customer-domain.example";
const CIPHERTEXT = "Y2lwaGVydGV4dC1ibG9i";
const ACTIVE_KEY_VERSION = 3;

/**
 * The path and query carry a bearer token on purpose: `recordAudit` must record
 * the HOSTNAME only, and `AUDIT_TOKEN` is the string whose absence proves it.
 */
const AUDIT_TOKEN = "bearer-9f3c";
const URL_FULL = `https://receiver.example.test/hook?token=${AUDIT_TOKEN}`;
const URL_HOST = "receiver.example.test";
const URL_OTHER = "https://elsewhere.example.test/inbox";

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});

const scoped = Object.freeze({ principal, workspaceId: WORKSPACE_ID });
const byId = Object.freeze({ ...scoped, webhookId: WEBHOOK_ID });

type Row = Record<string, unknown>;

/**
 * Carries `encryptedSecret` / `encryptionKeyVersion` the read paths never
 * select. A DTO that spreads a row rather than building one leaks them here.
 */
const storedRow: Row = Object.freeze({
  id: WEBHOOK_ID,
  workspaceId: WORKSPACE_ID,
  url: URL_FULL,
  events: ["note.created", "note.updated"],
  isEnabled: false,
  isVerified: false,
  createdById: USER_ID,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  encryptedSecret: CIPHERTEXT,
  encryptionKeyVersion: 1,
});

const deliveryRow: Row = Object.freeze({
  id: DELIVERY_ID,
  webhookId: WEBHOOK_ID,
  eventId: EVENT_ID,
  event: "note.created",
  status: "success",
  attempt: 1,
  responseStatus: 200,
  responseBodySnippet: "ok",
  errorMessage: null,
  payloadHash: "9f".repeat(32),
  deliveredAt: new Date("2026-08-18T09:31:00.000Z"),
  createdAt: new Date("2026-08-18T09:30:00.000Z"),
});

/** Stored with deliberately shuffled keys — see the canonical-order test. */
const outboxPayload: Row = Object.freeze({
  occurredAt: "2026-08-18T09:30:00.000Z",
  event: "note.created",
  webhookId: WEBHOOK_ID,
  action: DOMAIN_JOB_TYPES.webhookDeliver,
  actorId: USER_ID,
  eventId: EVENT_ID,
  intentId: INTENT_ID,
  resourceId: NOTE_ID,
  workspaceId: WORKSPACE_ID,
});

async function apiRejection(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

/** A database whose every access fails, proving authorization ran before SQL. */
function forbiddenDatabase(): DatabaseService {
  return {
    db: new Proxy(
      {},
      {
        get: () => {
          throw new Error("SQL must not run");
        },
      },
    ),
    transaction: () => {
      throw new Error("SQL must not run");
    },
  } as unknown as DatabaseService;
}

function mockEntry(tenant: TenantContextService): {
  readonly entry: AuthorizationEntryService;
  readonly authorizeUser: ReturnType<typeof vi.fn>;
} {
  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const entry = {
    authorizeUser,
    run: <T>(operation: { workspaceId: string; userId: string | null }, work: () => T): T =>
      tenant.run(
        createTenantContext({ workspaceId: operation.workspaceId, userId: operation.userId }),
        work,
      ),
  } as unknown as AuthorizationEntryService;
  return { entry, authorizeUser };
}

const dialect = new PgDialect();

/**
 * True when a captured predicate really constrains `table` to the active
 * workspace. Without rendering the real SQL this suite would stay green if
 * `whereWorkspace(...)` were deleted and a foreign tenant's endpoint became
 * readable, editable and replayable.
 */
function scopesToWorkspace(predicate: unknown, table: { readonly workspaceId: unknown }): boolean {
  if (predicate === undefined || predicate === null) return false;
  const column = dialect.sqlToQuery(sql`${table.workspaceId}`).sql;
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return rendered.sql.includes(`${column} =`) && rendered.params.includes(WORKSPACE_ID);
}

function renderedSql(predicate: unknown): string {
  return dialect.sqlToQuery(predicate as SQL).sql;
}

function boundParameters(predicate: unknown): readonly unknown[] {
  return dialect.sqlToQuery(predicate as SQL).params;
}

interface Statement {
  readonly table: unknown;
  readonly fields?: Record<string, unknown>;
  readonly predicate: unknown;
  readonly values?: Row;
  returningFields?: Record<string, unknown>;
}

interface Awaitable<T> extends Promise<T> {
  limit: (count: number) => Awaitable<T>;
  orderBy: (...columns: readonly unknown[]) => Awaitable<T>;
  offset: (count: number) => Awaitable<T>;
}

function rows(value: readonly unknown[]): Awaitable<unknown[]> {
  const promise = Promise.resolve([...value]) as Awaitable<unknown[]>;
  promise.limit = () => promise;
  promise.orderBy = () => promise;
  promise.offset = () => promise;
  return promise;
}

interface HarnessOptions {
  /** Answers every `webhooks` read. `[]` is the foreign-workspace case. */
  readonly webhookRows?: readonly Row[];
  readonly deliveryRows?: readonly Row[];
  readonly outboxRows?: readonly Row[];
  /** What the in-transaction `count(*)` cap probe sees. */
  readonly endpointCount?: number;
  /** Overrides the `UPDATE ... RETURNING` result (`[]` = the row vanished). */
  readonly updated?: readonly Row[];
  readonly deleted?: readonly Row[];
  readonly secretUnavailable?: boolean;
}

function serviceWith(options: HarnessOptions = {}) {
  const tenant = new TenantContextService();
  const { entry, authorizeUser } = mockEntry(tenant);
  const inserted: { readonly table: unknown; readonly values: Row }[] = [];
  const reads: Statement[] = [];
  const updates: Statement[] = [];
  const deletes: Statement[] = [];

  /** The row a read of `webhooks` sees, echoing a create's own INSERT back. */
  const webhookAnswer = (): readonly Row[] => {
    if (options.webhookRows !== undefined) return options.webhookRows;
    const written = inserted.find((entry_) => entry_.table === webhooks);
    return written === undefined ? [storedRow] : [{ ...storedRow, ...written.values }];
  };

  const answer = (table: unknown, fields: Record<string, unknown>): readonly unknown[] => {
    if (table === webhooks) {
      if ("total" in fields) return [{ total: options.endpointCount ?? 0 }];
      return webhookAnswer();
    }
    if (table === webhookDeliveries) return options.deliveryRows ?? [deliveryRow];
    if (table === jobOutbox) return options.outboxRows ?? [{ payload: outboxPayload }];
    return [];
  };

  const scope = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const source = {
          // `retryDelivery` joins `webhooks` in purely to hang the workspace
          // condition on; the rows still come from the `from` table.
          innerJoin: () => source,
          where: (predicate: unknown) => {
            reads.push({ table, fields, predicate });
            return rows(answer(table, fields));
          },
        };
        return source;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserted.push({ table, values });
        const promise = Promise.resolve(undefined) as Promise<undefined> & {
          returning: (fields: Record<string, unknown>) => Promise<unknown[]>;
        };
        // A real RETURNING answers with what was written, which is what makes
        // the recorded delivery row assertable.
        promise.returning = () => Promise.resolve([{ ...deliveryRow, ...values }]);
        return promise;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (predicate: unknown) => {
          const statement: Statement = { table, predicate, values };
          updates.push(statement);
          const promise = Promise.resolve(undefined) as Promise<undefined> & {
            returning: (fields: Record<string, unknown>) => Promise<unknown[]>;
          };
          promise.returning = (fields) => {
            statement.returningFields = fields;
            return Promise.resolve([...(options.updated ?? [{ ...storedRow, ...values }])]);
          };
          return promise;
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (predicate: unknown) => {
        deletes.push({ table, predicate });
        return {
          returning: () =>
            Promise.resolve([...(options.deleted ?? [{ id: WEBHOOK_ID, url: URL_FULL }])]),
        };
      },
    }),
  };

  const database = {
    db: scope,
    transaction: (work: (value: typeof scope) => Promise<unknown>) => work(scope),
  } as unknown as DatabaseService;

  const encrypt = vi.fn((webhookId: string) => ({
    encryptedSecret: `encrypted:${webhookId}`,
    encryptionKeyVersion: ACTIVE_KEY_VERSION,
  }));
  const decrypt = vi.fn(() => {
    if (options.secretUnavailable === true) throw new Error("Webhook secret is unreadable");
    return SECRET;
  });
  const secrets = {
    generate: () => SECRET,
    encrypt,
    decrypt,
  } as unknown as WebhookSecretService;

  // A verified custom domain of ANOTHER workspace, served by this same
  // deployment: the confused-deputy hostname `selfHostnames` cannot enumerate.
  const isVerifiedTenantHost = vi.fn((host: string) => Promise.resolve(host === TENANT_HOST));
  const verifiedHosts = { isVerifiedTenantHost } as unknown as VerifiedHostsService;

  const scheduleWebhookReplay = vi.fn().mockResolvedValue(true);
  const producer = { scheduleWebhookReplay } as unknown as WebhookDeliveryProducer;

  const service = new WebhooksService(
    database,
    entry,
    tenant,
    secrets,
    producer,
    {
      appUrl: new URL("https://app.notted.test"),
      apiUrl: new URL("https://api.notted.test"),
    } as AppConfig,
    { webhookAllowInsecureUrls: false } as SecurityConfig,
    verifiedHosts,
  );

  return {
    service,
    inserted,
    reads,
    updates,
    deletes,
    authorizeUser,
    encrypt,
    scheduleWebhookReplay,
  };
}

const auditOf = (inserted: readonly { readonly table: unknown; readonly values: Row }[]): Row =>
  (inserted.find((entry_) => entry_.table === auditLogs)?.values ?? {}) as Row;

const webhookInsertOf = (
  inserted: readonly { readonly table: unknown; readonly values: Row }[],
): Row => (inserted.find((entry_) => entry_.table === webhooks)?.values ?? {}) as Row;

beforeEach(() => {
  sent.mockReset();
  resolveHost.mockReset();
  resolveHost.mockResolvedValue("ok");
});

describe("WebhooksService authorization", () => {
  const cases: readonly [
    string,
    (service: WebhooksService) => Promise<unknown>,
    string,
    Record<string, string>,
  ][] = [
    [
      "list",
      (service) => service.list({ ...scoped, page: 1, limit: 25 }),
      "webhook.list",
      { kind: "workspace" },
    ],
    [
      "create",
      (service) => service.create({ ...scoped, url: URL_FULL, events: ["note.created"] }),
      "webhook.create",
      { kind: "workspace" },
    ],
    [
      "update",
      (service) => service.update({ ...byId, events: ["note.created"] }),
      "webhook.update",
      { kind: "webhook", id: WEBHOOK_ID },
    ],
    [
      "remove",
      (service) => service.remove(byId),
      "webhook.delete",
      { kind: "webhook", id: WEBHOOK_ID },
    ],
    [
      "rotateSecret",
      (service) => service.rotateSecret(byId),
      "webhook.update",
      { kind: "webhook", id: WEBHOOK_ID },
    ],
    [
      "verify",
      (service) => service.verify(byId),
      "webhook.update",
      { kind: "webhook", id: WEBHOOK_ID },
    ],
    [
      "listDeliveries",
      (service) => service.listDeliveries({ ...byId, page: 1, limit: 25 }),
      "webhook.list",
      { kind: "workspace" },
    ],
    [
      "retryDelivery",
      (service) => service.retryDelivery({ ...byId, deliveryId: DELIVERY_ID }),
      "webhook.redeliver",
      { kind: "webhook", id: WEBHOOK_ID },
    ],
  ];

  it.each(cases)("authorizes %s before any SQL", async (_name, invoke, action, resource) => {
    const denial = new Error("concealed");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const service = new WebhooksService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      {} as WebhookSecretService,
      {} as WebhookDeliveryProducer,
      {
        appUrl: new URL("https://app.notted.test"),
        apiUrl: new URL("https://api.notted.test"),
      } as AppConfig,
      { webhookAllowInsecureUrls: false } as SecurityConfig,
      { isVerifiedTenantHost: () => Promise.resolve(false) } as unknown as VerifiedHostsService,
    );
    await expect(invoke(service)).rejects.toBe(denial);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action, workspaceId: WORKSPACE_ID, resource }),
    );
    // The URL guard is inside `run`, so a denial must also cost no DNS lookup.
    expect(resolveHost).not.toHaveBeenCalled();
  });
});

describe("WebhooksService.list", () => {
  const input = Object.freeze({ ...scoped, page: 1, limit: 25 });

  it("never selects the encrypted secret or its key version", async () => {
    const { service, reads } = serviceWith();
    await service.list(input);
    const [read] = reads;
    expect(read?.table).toBe(webhooks);
    const keys = Object.keys(read?.fields ?? {});
    expect(keys).not.toContain("encryptedSecret");
    expect(keys).not.toContain("encryptionKeyVersion");
    const selected = Object.values(read?.fields ?? {});
    expect(selected).not.toContain(webhooks.encryptedSecret);
    expect(selected).not.toContain(webhooks.encryptionKeyVersion);
  });

  it("scopes the listing to the active workspace", async () => {
    const { service, reads } = serviceWith();
    await service.list(input);
    expect(scopesToWorkspace(reads[0]?.predicate, webhooks)).toBe(true);
  });

  it("returns no ciphertext even when the row carries one", async () => {
    // The fixture row DOES have `encryptedSecret`; the DTO is built key by key,
    // so the only way this leaks is a refactor that spreads the row.
    const { service } = serviceWith();
    const page = await service.list(input);
    expect(JSON.stringify(page)).not.toContain(CIPHERTEXT);
    expect(page.items[0]).not.toHaveProperty("encryptedSecret");
  });

  it("reports hasMore from the limit + 1 probe row and returns the page shape", async () => {
    const many = Array.from({ length: 3 }, (_value, index) => ({
      ...storedRow,
      id: `${WEBHOOK_ID.slice(0, -1)}${index}`,
    }));
    const { service } = serviceWith({ webhookRows: many });
    const page = await service.list({ ...input, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page).toMatchObject({ page: 1, limit: 2, hasMore: true });
  });

  it("drops a stored event that is no longer in the subscribable catalog", async () => {
    const { service } = serviceWith({
      webhookRows: [{ ...storedRow, events: ["note.created", "note.archived"] }],
    });
    const page = await service.list(input);
    expect(page.items[0]?.events).toEqual(["note.created"]);
  });
});

describe("WebhooksService.create", () => {
  const input = Object.freeze({
    ...scoped,
    url: URL_FULL,
    events: ["note.created", "note.updated"] as const,
  });

  it("mints the id before encrypting, so the ciphertext is bound to the row", async () => {
    const { service, inserted, encrypt } = serviceWith();
    const result = await service.create(input);
    const row = webhookInsertOf(inserted);
    // The AAD binds the secret to this id, so the id cannot come back from a
    // DEFAULT — it must exist before `encrypt` is called.
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(encrypt).toHaveBeenCalledWith(row.id, result.secret);
    expect(row.encryptedSecret).toBe(`encrypted:${String(row.id)}`);
    expect(row.encryptionKeyVersion).toBe(ACTIVE_KEY_VERSION);
  });

  it("stores a disabled, unverified endpoint scoped to the active workspace", async () => {
    const { service, inserted } = serviceWith();
    const result = await service.create(input);
    const row = webhookInsertOf(inserted);
    expect(row.isEnabled).toBe(false);
    expect(row.isVerified).toBe(false);
    expect(row.workspaceId).toBe(WORKSPACE_ID);
    expect(row.createdById).toBe(USER_ID);
    expect(row.events).toEqual(["note.created", "note.updated"]);
    expect(result.webhook.isEnabled).toBe(false);
    expect(result.webhook.isVerified).toBe(false);
  });

  it("returns the raw secret once and never inside the endpoint DTO", async () => {
    const { service } = serviceWith();
    const result = await service.create(input);
    expect(result.secret).toBe(SECRET);
    expect(JSON.stringify(result.webhook)).not.toContain(SECRET);
    expect(JSON.stringify(result.webhook)).not.toContain("encrypted:");
  });

  it("audits the creation with the hostname only, never the URL's token or the secret", async () => {
    const { service, inserted } = serviceWith();
    const result = await service.create(input);
    const audit = auditOf(inserted);
    expect(audit.action).toBe(WEBHOOK_AUDIT_ACTIONS.created);
    expect(audit.entityType).toBe(WEBHOOK_AUDIT_ENTITY_TYPE);
    expect(audit.entityId).toBe(webhookInsertOf(inserted).id);
    expect(audit.metadata).toEqual({ host: URL_HOST, events: ["note.created", "note.updated"] });
    // The path and query of a webhook URL routinely carry a bearer token, and
    // audit rows are long-lived and widely readable.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(AUDIT_TOKEN);
    expect(serialized).not.toContain("/hook");
    expect(serialized).not.toContain(result.secret);
  });

  it("counts the existing endpoints inside the transaction, scoped to the workspace", async () => {
    const { service, reads } = serviceWith();
    await service.create(input);
    const probe = reads.find((read) => read.fields !== undefined && "total" in read.fields);
    expect(probe?.table).toBe(webhooks);
    expect(scopesToWorkspace(probe?.predicate, webhooks)).toBe(true);
  });

  it("refuses the eleventh endpoint with a 409 and writes nothing", async () => {
    const { service, inserted } = serviceWith({ endpointCount: WEBHOOK_ENDPOINT_LIMIT });
    const error = await apiRejection(service.create(input));
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("CONFLICT");
    expect(inserted).toHaveLength(0);
  });

  it("rejects a URL whose host resolves into private space with 422 and no write", async () => {
    resolveHost.mockResolvedValue("dns_blocked");
    const { service, inserted } = serviceWith();
    const error = await apiRejection(service.create(input));
    expect(error.getStatus()).toBe(422);
    expect(error.safeResponse.code).toBe("WEBHOOK_URL_REJECTED");
    // Non-specific by design: naming the layer that refused, or the address a
    // name resolved to, is a private-network oracle.
    expect(error.safeResponse.message).toBe(
      "This webhook URL cannot be used as a delivery destination.",
    );
    expect(inserted).toHaveLength(0);
  });

  it("rejects a syntactically unusable URL before spending a DNS lookup", async () => {
    const { service } = serviceWith();
    // `http:` with `webhookAllowInsecureUrls: false` is the real guard's L1.
    const error = await apiRejection(
      service.create({ ...input, url: "http://receiver.example.test/hook" }),
    );
    expect(error.safeResponse.code).toBe("WEBHOOK_URL_REJECTED");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("hands the guard a live verified-host question, not just the configured pair", async () => {
    // The static pair is only what is known at boot. Without this wiring the
    // guard's `isSelfHost` branch is dead code and a verified custom domain of
    // another workspace remains a legal webhook destination.
    const { service } = serviceWith();
    await service.create({ ...input, url: `https://${TENANT_HOST}/hook` });

    const options = resolveHost.mock.calls.at(-1)?.[1];
    await expect(options?.isSelfHost?.(TENANT_HOST)).resolves.toBe(true);
    await expect(options?.isSelfHost?.("receiver.example.test")).resolves.toBe(false);
  });

  it("refuses an endpoint pointing back at our own API", async () => {
    const { service } = serviceWith();
    const error = await apiRejection(
      service.create({ ...input, url: "https://api.notted.test/api/v1/webhooks" }),
    );
    expect(error.safeResponse.code).toBe("WEBHOOK_URL_REJECTED");
  });
});

describe("WebhooksService.update", () => {
  it("resets verification and enablement in the SAME statement when the URL moves", async () => {
    const { service, updates } = serviceWith();
    const result = await service.update({ ...byId, url: URL_OTHER });
    const [update] = updates;
    expect(update?.values).toMatchObject({
      url: URL_OTHER,
      isVerified: false,
      isEnabled: false,
    });
    // There must be no window in which a re-pointed endpoint is still verified,
    // so the reset cannot be a second UPDATE.
    expect(updates).toHaveLength(1);
    expect(result.isVerified).toBe(false);
    expect(result.isEnabled).toBe(false);
  });

  it("leaves verification alone when the URL is unchanged", async () => {
    const { service, updates } = serviceWith();
    await service.update({ ...byId, url: URL_FULL, events: ["note.created"] });
    expect(updates[0]?.values).not.toHaveProperty("isVerified");
  });

  it("refuses to enable an unverified endpoint", async () => {
    const { service, updates } = serviceWith();
    const error = await apiRejection(service.update({ ...byId, isEnabled: true }));
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("WEBHOOK_NOT_VERIFIED");
    expect(updates).toHaveLength(0);
  });

  it("refuses to enable an endpoint in the same call that moves it", async () => {
    // Verification proved THAT host controls the secret; it proves nothing
    // about the next one, so enable-and-move is refused rather than reset.
    const { service } = serviceWith({ webhookRows: [{ ...storedRow, isVerified: true }] });
    const error = await apiRejection(service.update({ ...byId, url: URL_OTHER, isEnabled: true }));
    expect(error.safeResponse.code).toBe("WEBHOOK_NOT_VERIFIED");
  });

  it("enables a verified endpoint whose URL is untouched", async () => {
    const { service, updates } = serviceWith({ webhookRows: [{ ...storedRow, isVerified: true }] });
    const result = await service.update({ ...byId, isEnabled: true });
    expect(updates[0]?.values).toMatchObject({ isEnabled: true });
    expect(result.isEnabled).toBe(true);
  });

  it("pins both the id and the workspace, and returns no secret", async () => {
    const { service, updates } = serviceWith();
    const result = await service.update({ ...byId, events: ["note.created"] });
    const [update] = updates;
    expect(update?.table).toBe(webhooks);
    expect(scopesToWorkspace(update?.predicate, webhooks)).toBe(true);
    expect(boundParameters(update?.predicate)).toContain(WEBHOOK_ID);
    const returned = Object.keys(update?.returningFields ?? {});
    expect(returned).not.toContain("encryptedSecret");
    expect(returned).not.toContain("encryptionKeyVersion");
    expect(JSON.stringify(result)).not.toContain(CIPHERTEXT);
  });

  it("answers 404, never 403, for an endpoint in another workspace", async () => {
    const { service, reads } = serviceWith({ webhookRows: [] });
    const error = await apiRejection(service.update({ ...byId, events: ["note.created"] }));
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(error.safeResponse.message).toBe("The requested resource was not found.");
    // The probe that produced the 404 was itself workspace-scoped, so it could
    // not have confirmed a foreign row exists.
    expect(scopesToWorkspace(reads.at(-1)?.predicate, webhooks)).toBe(true);
  });

  it("answers 404 when the scoped UPDATE matches nothing", async () => {
    const { service, inserted } = serviceWith({ updated: [] });
    const error = await apiRejection(service.update({ ...byId, events: ["note.created"] }));
    expect(error.getStatus()).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it("audits the update with the hostname only", async () => {
    const { service, inserted } = serviceWith();
    await service.update({ ...byId, events: ["note.created"] });
    const audit = auditOf(inserted);
    expect(audit.action).toBe(WEBHOOK_AUDIT_ACTIONS.updated);
    expect(audit.metadata).toEqual({
      host: URL_HOST,
      events: ["note.created"],
      isEnabled: false,
      isVerified: false,
    });
    expect(JSON.stringify(audit)).not.toContain(AUDIT_TOKEN);
  });
});

describe("WebhooksService.remove", () => {
  it("deletes one workspace-scoped row and audits the hostname", async () => {
    const { service, deletes, inserted } = serviceWith();
    await expect(service.remove(byId)).resolves.toEqual({ webhookId: WEBHOOK_ID, deleted: true });
    const [statement] = deletes;
    expect(statement?.table).toBe(webhooks);
    expect(scopesToWorkspace(statement?.predicate, webhooks)).toBe(true);
    expect(boundParameters(statement?.predicate)).toContain(WEBHOOK_ID);
    const audit = auditOf(inserted);
    expect(audit.action).toBe(WEBHOOK_AUDIT_ACTIONS.deleted);
    expect(audit.metadata).toEqual({ host: URL_HOST });
  });

  it("answers 404 for an endpoint in another workspace", async () => {
    const { service, inserted } = serviceWith({ deleted: [] });
    const error = await apiRejection(service.remove(byId));
    expect(error.getStatus()).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it('audits an unparseable stored URL as "invalid" rather than throwing mid-transaction', async () => {
    const { service, inserted } = serviceWith({ deleted: [{ id: WEBHOOK_ID, url: "not-a-url" }] });
    await service.remove(byId);
    expect(auditOf(inserted).metadata).toEqual({ host: "invalid" });
  });
});

describe("WebhooksService.rotateSecret", () => {
  it("re-encrypts with the active key version and returns the new raw secret once", async () => {
    const { service, updates, encrypt } = serviceWith();
    const result = await service.rotateSecret(byId);
    expect(encrypt).toHaveBeenCalledWith(WEBHOOK_ID, SECRET);
    expect(updates[0]?.values).toMatchObject({
      encryptedSecret: `encrypted:${WEBHOOK_ID}`,
      // A rotation also migrates the row onto the CURRENT key, so the stored
      // version must be the active one and not the row's previous version.
      encryptionKeyVersion: ACTIVE_KEY_VERSION,
    });
    expect(result.secret).toBe(SECRET);
    expect(JSON.stringify(result.webhook)).not.toContain("encrypted:");
  });

  it("pins the id and the workspace and projects no secret back", async () => {
    const { service, updates } = serviceWith();
    await service.rotateSecret(byId);
    const [update] = updates;
    expect(scopesToWorkspace(update?.predicate, webhooks)).toBe(true);
    expect(boundParameters(update?.predicate)).toContain(WEBHOOK_ID);
    expect(Object.keys(update?.returningFields ?? {})).not.toContain("encryptedSecret");
  });

  it("audits the key version and the hostname, never the secret", async () => {
    const { service, inserted } = serviceWith();
    const result = await service.rotateSecret(byId);
    const audit = auditOf(inserted);
    expect(audit.action).toBe(WEBHOOK_AUDIT_ACTIONS.secretRotated);
    expect(audit.metadata).toEqual({ host: URL_HOST, encryptionKeyVersion: ACTIVE_KEY_VERSION });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(result.secret);
    expect(serialized).not.toContain(AUDIT_TOKEN);
  });

  it("answers 404 for an endpoint in another workspace", async () => {
    const { service, inserted } = serviceWith({ updated: [] });
    const error = await apiRejection(service.rotateSecret(byId));
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(inserted).toHaveLength(0);
  });
});

describe("WebhooksService.verify", () => {
  /** Echoes the challenge the service minted, the way a good receiver does. */
  function echoChallenge(status = 200): void {
    sent.mockImplementation((request: WebhookSendRequest) => {
      const body = JSON.parse(request.body) as { readonly data: { readonly challenge: string } };
      return Promise.resolve({
        outcome: "response",
        status,
        snippet: JSON.stringify({ challenge: body.data.challenge }),
        durationMs: 12,
      });
    });
  }

  it("sends one signed challenge and marks the endpoint verified", async () => {
    echoChallenge();
    const { service, updates, inserted } = serviceWith();
    const result = await service.verify(byId);

    expect(result.isVerified).toBe(true);
    const request = sent.mock.calls[0]?.[0];
    expect(request?.url).toBe(URL_FULL);
    expect(request?.headers["x-notted-event"]).toBe(WEBHOOK_VERIFICATION_EVENT);
    // The header the receiver logs and the row we store are the same id, so an
    // admin can match their log line to our attempt.
    expect(request?.headers["x-notted-delivery-id"]).toBe(result.delivery.id);
    expect(request?.headers["x-notted-event-id"]).toBe(result.delivery.eventId);
    expect(
      verifyWebhookSignature(
        SECRET,
        request?.headers["x-notted-signature"] ?? "",
        request?.body ?? "",
        Math.floor(Date.now() / 1_000),
      ),
    ).toBe(true);

    const [update] = updates;
    expect(scopesToWorkspace(update?.predicate, webhooks)).toBe(true);
    // Conditional on the prior state, so two concurrent verifications cannot
    // both believe they made the transition.
    expect(renderedSql(update?.predicate)).toContain("is_verified");
    expect(update?.values).toMatchObject({ isVerified: true });
    expect(auditOf(inserted).action).toBe(WEBHOOK_AUDIT_ACTIONS.verified);
    expect(auditOf(inserted).metadata).toEqual({ host: URL_HOST });
  });

  it("records the successful attempt as a delivered, non-retried row", async () => {
    echoChallenge();
    const { service, inserted } = serviceWith();
    const result = await service.verify(byId);
    const row = inserted.find((entry_) => entry_.table === webhookDeliveries)?.values;
    expect(row).toMatchObject({
      event: WEBHOOK_VERIFICATION_EVENT,
      status: "success",
      attempt: 1,
      errorMessage: null,
      responseStatus: 200,
    });
    expect(row?.deliveredAt).toBeInstanceOf(Date);
    expect(result.delivery.status).toBe("success");
  });

  it("writes the failed attempt BEFORE raising 422, so it survives in the history", async () => {
    // A response that does not echo the challenge. The attempt row is written
    // outside any transaction precisely so the 422 cannot roll it back.
    sent.mockResolvedValue({ outcome: "response", status: 200, snippet: "thanks", durationMs: 9 });
    const { service, inserted, updates } = serviceWith();
    const error = await apiRejection(service.verify(byId));
    expect(error.getStatus()).toBe(422);
    expect(error.safeResponse.code).toBe("WEBHOOK_VERIFICATION_FAILED");
    const row = inserted.find((entry_) => entry_.table === webhookDeliveries)?.values;
    expect(row).toMatchObject({
      status: "failed",
      errorMessage: "http_error",
      responseStatus: 200,
    });
    // Nothing was marked verified and nothing was audited as verified.
    expect(updates).toHaveLength(0);
    expect(inserted.some((entry_) => entry_.table === auditLogs)).toBe(false);
  });

  it("records a transport failure under its own error code", async () => {
    sent.mockResolvedValue({ outcome: "error", errorCode: "timeout", durationMs: 5_000 });
    const { service, inserted } = serviceWith();
    await apiRejection(service.verify(byId));
    expect(inserted.find((entry_) => entry_.table === webhookDeliveries)?.values).toMatchObject({
      status: "failed",
      errorMessage: "timeout",
      responseStatus: null,
    });
  });

  it("records secret_unavailable and never opens a connection when decryption fails", async () => {
    const { service, inserted } = serviceWith({ secretUnavailable: true });
    const error = await apiRejection(service.verify(byId));
    expect(error.safeResponse.code).toBe("WEBHOOK_VERIFICATION_FAILED");
    expect(inserted.find((entry_) => entry_.table === webhookDeliveries)?.values).toMatchObject({
      status: "failed",
      errorMessage: "secret_unavailable",
    });
    expect(sent).not.toHaveBeenCalled();
  });

  it("answers 404 for an endpoint in another workspace and sends nothing", async () => {
    const { service, reads } = serviceWith({ webhookRows: [] });
    const error = await apiRejection(service.verify(byId));
    expect(error.getStatus()).toBe(404);
    expect(sent).not.toHaveBeenCalled();
    expect(scopesToWorkspace(reads[0]?.predicate, webhooks)).toBe(true);
    expect(boundParameters(reads[0]?.predicate)).toContain(WEBHOOK_ID);
  });

  it("fails a 3xx that happens to echo the challenge", async () => {
    echoChallenge(302);
    const { service } = serviceWith();
    const error = await apiRejection(service.verify(byId));
    expect(error.safeResponse.code).toBe("WEBHOOK_VERIFICATION_FAILED");
  });
});

describe("WebhooksService.listDeliveries", () => {
  const input = Object.freeze({ ...byId, page: 1, limit: 25 });

  it("returns the bounded page shape", async () => {
    const { service } = serviceWith();
    const page = await service.listDeliveries(input);
    expect(page).toMatchObject({ page: 1, limit: 25, hasMore: false });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(DELIVERY_ID);
  });

  it("reports hasMore from the limit + 1 probe row", async () => {
    const many = Array.from({ length: 3 }, (_value, index) => ({
      ...deliveryRow,
      id: `${DELIVERY_ID.slice(0, -1)}${index}`,
    }));
    const { service } = serviceWith({ deliveryRows: many });
    const page = await service.listDeliveries({ ...input, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("proves ownership of the endpoint first, scoped to the workspace", async () => {
    const { service, reads } = serviceWith();
    await service.listDeliveries(input);
    const [probe] = reads;
    expect(probe?.table).toBe(webhooks);
    expect(scopesToWorkspace(probe?.predicate, webhooks)).toBe(true);
    expect(boundParameters(probe?.predicate)).toContain(WEBHOOK_ID);
  });

  it("answers 404 for a foreign endpoint without reading any delivery", async () => {
    // `webhook_deliveries` has no `workspace_id` of its own, so this ownership
    // probe IS the tenant boundary for the delivery log.
    const { service, reads } = serviceWith({ webhookRows: [] });
    const error = await apiRejection(service.listDeliveries(input));
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(reads.some((read) => read.table === webhookDeliveries)).toBe(false);
  });

  it("pushes an explicit status filter into the query", async () => {
    const { service, reads } = serviceWith();
    await service.listDeliveries({ ...input, status: "failed" });
    const query = reads.find((read) => read.table === webhookDeliveries);
    expect(boundParameters(query?.predicate)).toEqual(
      expect.arrayContaining([WEBHOOK_ID, "failed"]),
    );
  });

  it("narrows a free-text error message to null rather than echoing it", async () => {
    const { service } = serviceWith({
      deliveryRows: [{ ...deliveryRow, errorMessage: "connect ECONNREFUSED 10.0.0.5:443" }],
    });
    const page = await service.listDeliveries(input);
    expect(page.items[0]?.errorMessage).toBeNull();
  });
});

describe("WebhooksService.retryDelivery", () => {
  const input = Object.freeze({ ...byId, deliveryId: DELIVERY_ID });

  it("replays the original intent against the same event id", async () => {
    const { service, scheduleWebhookReplay } = serviceWith();
    const result = await service.retryDelivery(input);
    expect(result).toEqual({ webhookId: WEBHOOK_ID, eventId: EVENT_ID, scheduled: true });
    const call = scheduleWebhookReplay.mock.calls[0]?.[1] as {
      readonly webhookId: string;
      readonly eventId: string;
      readonly payload: Record<string, unknown>;
    };
    // The event id is stable across a replay — that is what lets a receiver
    // deduplicate. A NEW intent id is minted by the producer, which is asserted
    // in `webhook-delivery.producer.test.ts`.
    expect(call.eventId).toBe(EVENT_ID);
    expect(call.payload.eventId).toBe(EVENT_ID);
    expect(call.payload.intentId).toBe(INTENT_ID);
  });

  it("rebuilds the payload in the canonical key order the producer hashes", async () => {
    const { service, scheduleWebhookReplay } = serviceWith();
    await service.retryDelivery(input);
    const call = scheduleWebhookReplay.mock.calls[0]?.[1] as { readonly payload: object };
    // The stored jsonb's key order is not guaranteed, and the producer's
    // payload hash is order-sensitive, so the literal must re-establish it.
    expect(Object.keys(call.payload)).toEqual([
      "action",
      "intentId",
      "workspaceId",
      "webhookId",
      "eventId",
      "event",
      "resourceId",
      "actorId",
      "occurredAt",
    ]);
  });

  it("audits the replay with the event and delivery ids", async () => {
    const { service, inserted } = serviceWith();
    await service.retryDelivery(input);
    const audit = auditOf(inserted);
    expect(audit.action).toBe(WEBHOOK_AUDIT_ACTIONS.redelivered);
    expect(audit.entityId).toBe(WEBHOOK_ID);
    expect(audit.metadata).toEqual({ eventId: EVENT_ID, deliveryId: DELIVERY_ID });
  });

  it("answers 409 once the outbox intent has been pruned", async () => {
    // Outbox rows are prunable, so "this can no longer be replayed" is a normal
    // answer rather than an error — and never an invented payload.
    const { service, scheduleWebhookReplay } = serviceWith({ outboxRows: [] });
    const error = await apiRejection(service.retryDelivery(input));
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("CONFLICT");
    expect(error.safeResponse.message).toBe("This delivery can no longer be replayed.");
    expect(scheduleWebhookReplay).not.toHaveBeenCalled();
  });

  it("answers 409 when the stored intent fails its registry schema", async () => {
    const { service, scheduleWebhookReplay } = serviceWith({
      outboxRows: [{ payload: { ...outboxPayload, occurredAt: "yesterday" } }],
    });
    expect((await apiRejection(service.retryDelivery(input))).getStatus()).toBe(409);
    expect(scheduleWebhookReplay).not.toHaveBeenCalled();
  });

  it("refuses an intent that names a different endpoint", async () => {
    // Belt and braces on top of the scoped read: the outbox row is fetched by
    // event id, so its `webhookId` must be re-checked against the route's.
    const { service, scheduleWebhookReplay } = serviceWith({
      outboxRows: [
        { payload: { ...outboxPayload, webhookId: "60000000-0000-4000-8200-000000000009" } },
      ],
    });
    expect((await apiRejection(service.retryDelivery(input))).getStatus()).toBe(409);
    expect(scheduleWebhookReplay).not.toHaveBeenCalled();
  });

  it("scopes the delivery lookup through its endpoint and the outbox by workspace", async () => {
    const { service, reads } = serviceWith();
    await service.retryDelivery(input);
    const deliveryRead = reads.find((read) => read.table === webhookDeliveries);
    // The join exists so the workspace condition can hang off `webhooks`.
    expect(scopesToWorkspace(deliveryRead?.predicate, webhooks)).toBe(true);
    expect(boundParameters(deliveryRead?.predicate)).toEqual(
      expect.arrayContaining([DELIVERY_ID, WEBHOOK_ID, WORKSPACE_ID]),
    );
    const outboxRead = reads.find((read) => read.table === jobOutbox);
    expect(scopesToWorkspace(outboxRead?.predicate, jobOutbox)).toBe(true);
  });

  it("answers 404, never 403, for a delivery in another workspace", async () => {
    const { service, scheduleWebhookReplay } = serviceWith({ deliveryRows: [] });
    const error = await apiRejection(service.retryDelivery(input));
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(scheduleWebhookReplay).not.toHaveBeenCalled();
  });
});
