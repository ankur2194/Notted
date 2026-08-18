import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiKey, listApiKeys, revokeApiKey } from "./requests";

const workspaceId = "50000000-0000-4000-8000-000000000001";
const apiKeyId = "50000000-0000-4000-8000-000000000002";
const userId = "50000000-0000-4000-8000-000000000003";

const apiKey = {
  id: apiKeyId,
  workspaceId,
  name: "CI deploy",
  keyPrefix: "ntd_pk_a",
  scopes: ["read", "write"],
  lastUsedAt: null,
  expiresAt: null,
  isRevoked: false,
  createdById: userId,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const secret = "ntd_pk_abcdefghijklmnopqrstuvwxyz012345";

const listQuery = {
  page: 1,
  limit: 50,
  includeRevoked: true,
  sortBy: "createdAt",
  sortDirection: "desc",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api key requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends every list selector and parses the page", async () => {
    const body = { items: [apiKey], page: 1, limit: 50, hasMore: false };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(listApiKeys(workspaceId, listQuery)).resolves.toEqual({ ok: true, data: body });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/api-keys`);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("includeRevoked")).toBe("true");
    expect(url.searchParams.get("sortBy")).toBe("createdAt");
    expect(url.searchParams.get("sortDirection")).toBe("desc");
  });

  it("omits includeRevoked rather than sending it as false", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25, hasMore: false }));

    await listApiKeys(workspaceId, { ...listQuery, limit: 25, includeRevoked: false });

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.has("includeRevoked")).toBe(
      false,
    );
  });

  it("sends an idempotency key on create, and a different one per submission", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apiKey, secret }, 201));

    await createApiKey(workspaceId, { name: "CI deploy" }, "first-submission-key");
    await createApiKey(workspaceId, { name: "CI deploy" }, "second-submission-key");

    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key");
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key");
    expect(first).toBe("first-submission-key");
    expect(second).toBe("second-submission-key");
    // A replayed create cannot reproduce the secret, so a retry must be a new key.
    expect(first).not.toBe(second);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("returns the one-time secret alongside the summary", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apiKey, secret }, 201));

    await expect(
      createApiKey(workspaceId, { name: "CI deploy" }, "stable-submission-key"),
    ).resolves.toEqual({ ok: true, data: { apiKey, secret } });
  });

  it("applies the shared default scopes when the caller sends none", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apiKey, secret }, 201));

    await createApiKey(workspaceId, { name: "CI deploy" }, "stable-submission-key");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "CI deploy",
      scopes: ["read", "write"],
    });
  });

  it("fails closed on bad ids, bad input, and a weak idempotency key", async () => {
    await expect(listApiKeys("not-a-uuid", listQuery)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(revokeApiKey(workspaceId, "not-a-uuid")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(
      createApiKey("not-a-uuid", { name: "CI" }, "stable-submission-key"),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(
      createApiKey(workspaceId, { name: "  " }, "stable-submission-key"),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(
      createApiKey(workspaceId, { name: "CI", scopes: [] }, "stable-submission-key"),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(
      createApiKey(
        workspaceId,
        { name: "CI", expiresAt: "2000-01-01T00:00:00.000Z" },
        "stable-submission-key",
      ),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(createApiKey(workspaceId, { name: "CI" }, "short")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an off-contract response body as invalid rather than trusting it", async () => {
    // A secret that does not match the shared pattern is not a usable credential.
    fetchMock.mockResolvedValue(jsonResponse({ apiKey, secret: "not-a-real-secret" }, 201));
    await expect(
      createApiKey(workspaceId, { name: "CI deploy" }, "stable-submission-key"),
    ).resolves.toEqual({ ok: false, kind: "invalid" });

    fetchMock.mockResolvedValue(jsonResponse({ items: [{ ...apiKey, scopes: [] }], page: 1 }));
    await expect(listApiKeys(workspaceId, listQuery)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("maps permission and outage statuses onto the shared failure kinds", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "FORBIDDEN" } }, 403));
    await expect(listApiKeys(workspaceId, listQuery)).resolves.toEqual({
      ok: false,
      kind: "forbidden-or-not-found",
    });

    // A cross-workspace key is a 404 and must be indistinguishable from a denial.
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "NOT_FOUND" } }, 404));
    await expect(revokeApiKey(workspaceId, apiKeyId)).resolves.toEqual({
      ok: false,
      kind: "forbidden-or-not-found",
    });

    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "API_KEY_NAME_TAKEN" } }, 409));
    await expect(
      createApiKey(workspaceId, { name: "CI deploy" }, "stable-submission-key"),
    ).resolves.toEqual({ ok: false, kind: "conflict", code: "API_KEY_NAME_TAKEN" });

    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    await expect(listApiKeys(workspaceId, listQuery)).resolves.toMatchObject({
      ok: false,
      kind: "unavailable",
      retryable: true,
    });
  });

  it("revokes by DELETE and accepts the idempotent success body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apiKeyId, revoked: true }));

    await expect(revokeApiKey(workspaceId, apiKeyId)).resolves.toEqual({
      ok: true,
      data: { apiKeyId, revoked: true },
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/api-keys/${apiKeyId}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
