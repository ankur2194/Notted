import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookDelivery, WebhookEndpoint } from "@notted/shared-types";

import {
  createWebhook,
  deleteWebhook,
  loadWebhookDeliveries,
  loadWebhooks,
  retryWebhookDelivery,
  rotateWebhookSecret,
  updateWebhook,
  verifyWebhook,
} from "@/lib/webhooks/requests";

const WORKSPACE_ID = "60000000-0000-4000-8000-000000000001";
const WEBHOOK_ID = "60000000-0000-4000-8000-000000000002";
const DELIVERY_ID = "60000000-0000-4000-8000-000000000003";
const EVENT_ID = "60000000-0000-4000-8000-000000000004";
const USER_ID = "60000000-0000-4000-8000-000000000005";
const SECRET = "whsec_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const webhook = {
  id: WEBHOOK_ID,
  workspaceId: WORKSPACE_ID,
  url: "https://hooks.example.com/notted",
  events: ["note.created", "note.updated"],
  isEnabled: false,
  isVerified: false,
  createdById: USER_ID,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WebhookEndpoint;

const delivery = {
  id: DELIVERY_ID,
  webhookId: WEBHOOK_ID,
  eventId: EVENT_ID,
  event: "note.created",
  status: "failed",
  attempt: 2,
  responseStatus: 500,
  responseBodySnippet: "upstream exploded",
  errorMessage: "http_error",
  payloadHash: "a".repeat(64),
  deliveredAt: null,
  createdAt: "2026-08-02T00:00:00.000Z",
} satisfies WebhookDelivery;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function page(items: readonly unknown[]): Record<string, unknown> {
  return { items, page: 1, limit: 25, hasMore: false };
}

describe("webhook requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  function lastCall(): { readonly path: string; readonly init: RequestInit | undefined } {
    const call = fetchMock.mock.calls.at(-1);
    const target = call?.[0];
    const url = new URL(String(target));
    return { path: `${url.pathname}${url.search}`, init: call?.[1] };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reads the endpoint collection for a workspace", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page([webhook])));

    const result = await loadWebhooks(WORKSPACE_ID);

    expect(result).toEqual({
      ok: true,
      data: { items: [webhook], page: 1, limit: 25, hasMore: false },
    });
    expect(lastCall().path).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/webhooks`);
  });

  it("posts the url and events, and returns the one-time secret", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ webhook, secret: SECRET }, 201));

    const result = await createWebhook(WORKSPACE_ID, {
      url: "https://hooks.example.com/notted",
      events: ["note.created"],
    });

    expect(result).toEqual({ ok: true, data: { webhook, secret: SECRET } });
    const { path, init } = lastCall();
    expect(path).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/webhooks`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://hooks.example.com/notted",
      events: ["note.created"],
    });
  });

  it("refuses a create whose events list is empty without asking the server", async () => {
    const result = await createWebhook(WORKSPACE_ID, {
      url: "https://hooks.example.com/notted",
      events: [],
    });

    expect(result).toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("patches only the fields it was given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...webhook, isEnabled: true }));

    const result = await updateWebhook(WORKSPACE_ID, WEBHOOK_ID, { isEnabled: true });

    expect(result).toEqual({ ok: true, data: { ...webhook, isEnabled: true } });
    const { path, init } = lastCall();
    expect(path).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/webhooks/${WEBHOOK_ID}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ isEnabled: true });
  });

  it("returns the deletion result body the endpoint actually answers with", async () => {
    // The controller sets no `@HttpCode`, so a scoped DELETE answers 200 with a
    // body, exactly like `api-keys` and `tags`. There is no no-content route
    // here, which is why this goes through `requestJson` like every sibling.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ webhookId: WEBHOOK_ID, deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await deleteWebhook(WORKSPACE_ID, WEBHOOK_ID);

    expect(result).toEqual({ ok: true, data: { webhookId: WEBHOOK_ID, deleted: true } });
    const { path, init } = lastCall();
    expect(path).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/webhooks/${WEBHOOK_ID}`);
    expect(init?.method).toBe("DELETE");
  });

  it("maps a deletion the caller may not perform to the permission failure", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    await expect(deleteWebhook(WORKSPACE_ID, WEBHOOK_ID)).resolves.toEqual({
      ok: false,
      kind: "forbidden-or-not-found",
    });
  });

  it("rotates the secret with an empty POST body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ webhook, secret: SECRET }));

    const result = await rotateWebhookSecret(WORKSPACE_ID, WEBHOOK_ID);

    expect(result).toEqual({ ok: true, data: { webhook, secret: SECRET } });
    const { path, init } = lastCall();
    expect(path).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/webhooks/${WEBHOOK_ID}/rotate-secret`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it("reports verification from the response rather than from the request succeeding", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ webhook, isVerified: false, delivery }));

    const result = await verifyWebhook(WORKSPACE_ID, WEBHOOK_ID);

    expect(result).toEqual({ ok: true, data: { webhook, isVerified: false, delivery } });
    expect(lastCall().path).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/webhooks/${WEBHOOK_ID}/verify`,
    );
  });

  it("serializes the delivery page query onto the wire", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page([delivery])));

    const result = await loadWebhookDeliveries(WORKSPACE_ID, WEBHOOK_ID, {
      page: 2,
      limit: 20,
      status: "failed",
    });

    expect(result.ok).toBe(true);
    expect(lastCall().path).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/webhooks/${WEBHOOK_ID}/deliveries?page=2&limit=20&status=failed`,
    );
  });

  it("rejects a delivery page the server sent off-contract instead of surfacing it", async () => {
    // `attempt` is a string and the error code is not in the shared catalog:
    // exactly the two things a table row would otherwise render as fact.
    fetchMock.mockResolvedValue(
      jsonResponse(page([{ ...delivery, attempt: "2", errorMessage: "kaboom" }])),
    );

    await expect(
      loadWebhookDeliveries(WORKSPACE_ID, WEBHOOK_ID, { page: 1, limit: 25 }),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
  });

  it("rejects an endpoint carrying an event this build does not know", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page([{ ...webhook, events: ["note.exploded"] }])));

    await expect(loadWebhooks(WORKSPACE_ID)).resolves.toEqual({ ok: false, kind: "invalid" });
  });

  it("rejects a secret that does not carry the signing prefix", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ webhook, secret: "not-a-secret" }, 201));

    await expect(
      createWebhook(WORKSPACE_ID, { url: webhook.url, events: ["note.created"] }),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
  });

  it("queues a retry for one recorded delivery", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ webhookId: WEBHOOK_ID, eventId: EVENT_ID, scheduled: true }, 202),
    );

    const result = await retryWebhookDelivery(WORKSPACE_ID, WEBHOOK_ID, DELIVERY_ID);

    expect(result).toEqual({
      ok: true,
      data: { webhookId: WEBHOOK_ID, eventId: EVENT_ID, scheduled: true },
    });
    expect(lastCall().path).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/webhooks/${WEBHOOK_ID}/deliveries/${DELIVERY_ID}/retry`,
    );
  });

  it("short-circuits every route when an id is not a UUID", async () => {
    const results = await Promise.all([
      loadWebhooks("not-a-uuid"),
      createWebhook("not-a-uuid", { url: webhook.url, events: ["note.created"] }),
      updateWebhook(WORKSPACE_ID, "not-a-uuid", { isEnabled: true }),
      deleteWebhook(WORKSPACE_ID, "not-a-uuid"),
      rotateWebhookSecret(WORKSPACE_ID, "not-a-uuid"),
      verifyWebhook("not-a-uuid", WEBHOOK_ID),
      loadWebhookDeliveries(WORKSPACE_ID, "not-a-uuid", { page: 1, limit: 25 }),
      retryWebhookDelivery(WORKSPACE_ID, WEBHOOK_ID, "not-a-uuid"),
    ]);

    for (const result of results) expect(result).toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the caller the 409 error code so it can say which conflict this is", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: { code: "WEBHOOK_NOT_VERIFIED" } }, 409),
    );

    await expect(updateWebhook(WORKSPACE_ID, WEBHOOK_ID, { isEnabled: true })).resolves.toEqual({
      ok: false,
      kind: "conflict",
      code: "WEBHOOK_NOT_VERIFIED",
    });
  });

  it("reports a 422 rejection as invalid rather than as an outage", async () => {
    // `requestJson` reads the envelope's `code` on a 409 today; the 400/422
    // passthrough is a separate change. Asserting the `kind` keeps this test
    // true either way — the component already degrades to generic copy when
    // `code` is absent.
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: { code: "WEBHOOK_URL_REJECTED" } }, 422),
    );

    const result = await createWebhook(WORKSPACE_ID, {
      url: "https://hooks.example.com/notted",
      events: ["note.created"],
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "invalid" });
  });
});
