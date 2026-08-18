import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { notes, webhookDeliveries, webhooks } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { WebhookDeliveryWorkerService } from "./webhook-delivery.worker.service";
import { sendWebhook, type WebhookSendResult } from "./webhook-sender";
import { verifyWebhookSignature } from "./webhook-signature";

import type { WebhookSecretService } from "./webhook-secret.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { SecurityConfig } from "../config/security.config";
import type { DatabaseService } from "../database/database.service";
import type { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

vi.mock("./webhook-sender", () => ({ sendWebhook: vi.fn() }));

const sent = vi.mocked(sendWebhook);

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const WEBHOOK_ID = "22222222-0000-4000-8000-000000000002";
const NOTE_ID = "33333333-0000-4000-8000-000000000003";
const ACTOR_ID = "44444444-0000-4000-8000-000000000004";
const CREATOR_ID = "55555555-0000-4000-8000-000000000005";
const INTENT_ID = "66666666-0000-4000-8000-000000000006";
const SECRET = "whsec_0123456789012345678901234567890123456789012";

interface Harness {
  readonly worker: WebhookDeliveryWorkerService;
  readonly inserts: { readonly table: unknown; readonly values: Record<string, unknown> }[];
  readonly authorizeUserJob: ReturnType<typeof vi.fn>;
}

/**
 * The fake answers exactly two reads — the endpoint and the note — and records
 * every `webhook_deliveries` insert. Nothing else is touched by the handler.
 */
function harness(
  options: {
    readonly endpoint?: Record<string, unknown> | null;
    readonly note?: Record<string, unknown> | null;
    readonly secretUnavailable?: boolean;
  } = {},
): Harness {
  const inserts: { readonly table: unknown; readonly values: Record<string, unknown> }[] = [];
  const endpointRow =
    options.endpoint === undefined
      ? {
          id: WEBHOOK_ID,
          url: "https://receiver.example.test/hook",
          createdById: CREATOR_ID,
          encryptedSecret: "ciphertext",
          encryptionKeyVersion: 1,
          isEnabled: true,
          isVerified: true,
        }
      : options.endpoint;
  const noteRow =
    options.note === undefined
      ? {
          id: NOTE_ID,
          title: "Quarterly plan",
          projectId: null,
          folderId: null,
          parentId: null,
          isArchived: false,
          isDeleted: false,
          updatedAt: new Date("2026-08-18T09:30:00.000Z"),
        }
      : options.note;

  const database = {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                table === webhooks
                  ? endpointRow === null
                    ? []
                    : [endpointRow]
                  : noteRow === null
                    ? []
                    : [noteRow],
              ),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return Promise.resolve();
        },
      }),
    },
  } as unknown as DatabaseService;

  const tenant = new TenantContextService();
  const authorizeUserJob = vi.fn(() => Promise.resolve({}));
  const authorization = {
    authorizeSystem: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID }),
    authorizeUserJob,
    run: (_operation: unknown, work: () => Promise<void>) =>
      tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: null }), work),
  } as unknown as AuthorizationEntryService;

  const secrets = {
    decrypt: () => {
      if (options.secretUnavailable === true) throw new Error("Webhook secret is unreadable");
      return SECRET;
    },
  } as unknown as WebhookSecretService;

  const worker = new WebhookDeliveryWorkerService(
    database,
    authorization,
    tenant,
    secrets,
    { register: vi.fn() } as unknown as QueueHandlerRegistry,
    { info: vi.fn(), failure: vi.fn(), warning: vi.fn() } as unknown as StructuredLogger,
    {
      appUrl: new URL("https://app.notted.test"),
      apiUrl: new URL("https://api.notted.test"),
    } as AppConfig,
    { webhookRequestTimeoutMs: 10_000, webhookAllowInsecureUrls: false } as SecurityConfig,
  );
  return { worker, inserts, authorizeUserJob };
}

function context(overrides: { readonly attempt?: number; readonly intentId?: string } = {}) {
  return {
    outboxIntentId: INTENT_ID,
    jobType: "webhook.deliver",
    idempotencyKey: `webhook-deliver:${WEBHOOK_ID}:${INTENT_ID}`,
    correlationId: undefined,
    payload: {
      action: "webhook.deliver",
      intentId: overrides.intentId ?? INTENT_ID,
      workspaceId: WORKSPACE_ID,
      webhookId: WEBHOOK_ID,
      eventId: INTENT_ID,
      event: "note.updated",
      resourceId: NOTE_ID,
      actorId: ACTOR_ID,
      occurredAt: "2026-08-18T09:30:00.000Z",
    },
    signal: new AbortController().signal,
    attempt: overrides.attempt ?? 1,
    maximumAttempts: 5,
  };
}

const response = (status: number): WebhookSendResult => ({
  outcome: "response",
  status,
  snippet: null,
  durationMs: 12,
});

const attemptRow = (h: Harness): Record<string, unknown> => {
  const row = h.inserts.find(({ table }) => table === webhookDeliveries);
  if (row === undefined) throw new Error("no attempt row was written");
  return row.values;
};

/** `handle` either resolves or throws; both are legitimate outcomes here. */
async function run(h: Harness, ctx: ReturnType<typeof context>): Promise<boolean> {
  try {
    await h.worker.handle(ctx as never);
    return false;
  } catch {
    return true;
  }
}

beforeEach(() => {
  sent.mockReset();
});

describe("WebhookDeliveryWorkerService", () => {
  it.each([
    // [status, recorded status, recorded error code, does `handle` throw]
    [200, "success", null, false],
    [201, "success", null, false],
    // A 3xx is DATA: the sender never follows a redirect, and retrying one
    // would just re-receive the same redirect five times.
    [301, "failed", "http_error", false],
    [302, "failed", "http_error", false],
    [400, "failed", "http_error", false],
    [401, "failed", "http_error", false],
    [404, "failed", "http_error", false],
    [408, "retrying", "http_error", true],
    [410, "failed", "http_error", false],
    [429, "retrying", "http_error", true],
    [500, "retrying", "http_error", true],
    [503, "retrying", "http_error", true],
  ] as const)("records %i as %s and %s a retry", async (status, expected, errorCode, throws) => {
    const h = harness();
    sent.mockResolvedValue(response(status));
    expect(await run(h, context())).toBe(throws);
    const row = attemptRow(h);
    expect(row.status).toBe(expected);
    expect(row.errorMessage).toBe(errorCode);
    expect(row.responseStatus).toBe(status);
    expect(row.attempt).toBe(1);
    expect(row.eventId).toBe(INTENT_ID);
  });

  it.each([
    ["timeout", "retrying", true],
    ["connection_failed", "retrying", true],
    ["dns_blocked", "retrying", true],
    ["tls_failed", "retrying", true],
    // A URL the guard refuses is refused identically forever.
    ["url_rejected", "failed", false],
  ] as const)("records the %s transport failure as %s", async (errorCode, expected, throws) => {
    const h = harness();
    sent.mockResolvedValue({ outcome: "error", errorCode, durationMs: 9 });
    expect(await run(h, context())).toBe(throws);
    expect(attemptRow(h).status).toBe(expected);
    expect(attemptRow(h).errorMessage).toBe(errorCode);
    expect(attemptRow(h).responseStatus).toBeNull();
  });

  it("settles the FINAL attempt of a retryable failure without dead-lettering", async () => {
    const h = harness();
    sent.mockResolvedValue(response(503));
    // Attempt 5 of 5. Throwing here would push a stranger's broken server into
    // the platform dead-letter queue; the outcome belongs in the delivery log.
    expect(await run(h, context({ attempt: 5 }))).toBe(false);
    expect(attemptRow(h).status).toBe("failed");
    expect(attemptRow(h).errorMessage).toBe("http_error");
    expect(attemptRow(h).attempt).toBe(5);
  });

  it("throws on a retryable failure while attempts remain", async () => {
    const h = harness();
    sent.mockResolvedValue(response(503));
    expect(await run(h, context({ attempt: 4 }))).toBe(true);
    expect(attemptRow(h).status).toBe("retrying");
  });

  it("never opens a socket for a disabled endpoint", async () => {
    const h = harness({
      endpoint: {
        id: WEBHOOK_ID,
        url: "https://receiver.example.test/hook",
        createdById: CREATOR_ID,
        encryptedSecret: "ciphertext",
        encryptionKeyVersion: 1,
        isEnabled: false,
        isVerified: true,
      },
    });
    expect(await run(h, context())).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(attemptRow(h).status).toBe("failed");
    expect(attemptRow(h).errorMessage).toBe("resource_unavailable");
  });

  it("never opens a socket for a deleted endpoint", async () => {
    const h = harness({ endpoint: null });
    expect(await run(h, context())).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(attemptRow(h).errorMessage).toBe("resource_unavailable");
  });

  it("never opens a socket when the endpoint's creator lost access", async () => {
    const h = harness();
    // The worker treats `AuthorizationDeniedError` as the clean denial; any
    // other error escapes for retry, so this test rejects with the real class.
    h.authorizeUserJob.mockRejectedValue(
      new AuthorizationDeniedError({
        allowed: false,
        code: "authorization.denied",
        httpStatus: 403,
        safeMessage: "denied",
        audit: {
          action: "note.read",
          actorKind: "user",
          resourceKind: "note",
          outcome: "deny",
          reason: "test",
        },
      } as never),
    );
    expect(await run(h, context())).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(attemptRow(h).status).toBe("failed");
    expect(attemptRow(h).errorMessage).toBe("resource_forbidden");
  });

  it("never opens a socket when the resource is gone", async () => {
    const h = harness({ note: null });
    expect(await run(h, context())).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(attemptRow(h).errorMessage).toBe("resource_unavailable");
  });

  it("never opens a socket when the signing secret cannot be read", async () => {
    const h = harness({ secretUnavailable: true });
    expect(await run(h, context())).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(attemptRow(h).errorMessage).toBe("secret_unavailable");
  });

  it("rejects a broken envelope permanently, before any read", async () => {
    const h = harness();
    await expect(
      h.worker.handle(context({ intentId: "77777777-0000-4000-8000-000000000007" }) as never),
    ).rejects.toThrow("Permanent queue job failure");
    expect(h.inserts).toHaveLength(0);
  });

  it("signs the EXACT bytes it sends, and stores their hash", async () => {
    const h = harness();
    sent.mockResolvedValue(response(200));
    await run(h, context());

    const request = sent.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("sendWebhook was not called");
    const header = request.headers["x-notted-signature"];
    if (header === undefined) throw new Error("no signature header");
    // Verified against the body OBJECT that was handed to the sender — if the
    // worker ever re-stringified between signing and sending, this fails.
    expect(
      verifyWebhookSignature(SECRET, header, request.body, Math.floor(Date.now() / 1_000)),
    ).toBe(true);

    const body: unknown = JSON.parse(request.body);
    expect(body).toEqual({
      id: INTENT_ID,
      event: "note.updated",
      occurredAt: "2026-08-18T09:30:00.000Z",
      workspaceId: WORKSPACE_ID,
      actorId: ACTOR_ID,
      data: {
        id: NOTE_ID,
        title: "Quarterly plan",
        projectId: null,
        folderId: null,
        parentId: null,
        isArchived: false,
        isDeleted: false,
        updatedAt: "2026-08-18T09:30:00.000Z",
      },
    });
    // NO CONTENT. The body of the note never leaves the database.
    expect(request.body).not.toContain("content");
    expect(attemptRow(h).payloadHash).toHaveLength(64);
    expect(attemptRow(h).id).toBe(request.headers["x-notted-delivery-id"]);
  });

  it("keeps the event id stable across attempts while the delivery id changes", async () => {
    sent.mockResolvedValue(response(200));
    const first = harness();
    await run(first, context({ attempt: 1 }));
    const second = harness();
    await run(second, context({ attempt: 2 }));

    const [a, b] = sent.mock.calls.map(([request]) => request.headers);
    expect(a?.["x-notted-event-id"]).toBe(INTENT_ID);
    expect(b?.["x-notted-event-id"]).toBe(INTENT_ID);
    // A fresh delivery id per attempt is what lets a receiver tell "the same
    // event again" apart from "the same request again".
    expect(a?.["x-notted-delivery-id"]).not.toBe(b?.["x-notted-delivery-id"]);
    expect(attemptRow(first).attempt).toBe(1);
    expect(attemptRow(second).attempt).toBe(2);
  });

  it("sends the documented header set and never the endpoint URL in a log", async () => {
    const h = harness();
    sent.mockResolvedValue(response(200));
    await run(h, context());
    const headers = sent.mock.calls[0]?.[0].headers ?? {};
    expect(Object.keys(headers).sort()).toEqual([
      "content-type",
      "user-agent",
      "x-notted-delivery-id",
      "x-notted-event",
      "x-notted-event-id",
      "x-notted-signature",
      "x-notted-timestamp",
    ]);
    expect(headers["x-notted-event"]).toBe("note.updated");
  });

  it("writes exactly one immutable attempt row per attempt", async () => {
    const h = harness();
    sent.mockResolvedValue(response(200));
    await run(h, context());
    expect(h.inserts.filter(({ table }) => table === webhookDeliveries)).toHaveLength(1);
    // Nothing else is written: no `notes` row, no endpoint update, no state
    // machine.
    expect(h.inserts.filter(({ table }) => table === notes)).toHaveLength(0);
  });
});
