import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadWorkspaceDomain,
  removeWorkspaceDomain,
  setWorkspaceDomain,
  verifyWorkspaceDomain,
} from "./domain-requests";

const workspaceId = "50000000-0000-4000-8000-000000000001";

const domain = {
  id: "50000000-0000-4000-8000-000000000002",
  workspaceId,
  hostname: "notes.example.com",
  status: "pending",
  lastError: null,
  lastCheckedAt: null,
  verifiedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  verificationRecord: {
    name: "_notted-verify.notes.example.com",
    type: "TXT",
    value: "notted-verify=abc123",
  },
  cnameRecord: { name: "notes.example.com", type: "CNAME", value: "edge.notted.example" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("workspace domain requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reads the singleton domain route", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ domain }));

    await expect(loadWorkspaceDomain(workspaceId)).resolves.toEqual({
      ok: true,
      data: { domain },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/workspaces/${workspaceId}/domain`);
    expect(init?.method).toBeUndefined();
  });

  it("claims a hostname with PUT, normalised by the shared schema", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ domain }));

    await setWorkspaceDomain(workspaceId, "  NOTES.Example.com.  ");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/workspaces/${workspaceId}/domain`);
    expect(init?.method).toBe("PUT");
    // Trimmed, lowercased, root dot stripped — the browser must not be able to
    // store a second spelling of a globally unique hostname.
    expect(init?.body).toBe(JSON.stringify({ hostname: "notes.example.com" }));
  });

  it("re-checks through the verify sub-route with POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ domain }));

    await verifyWorkspaceDomain(workspaceId);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/workspaces/${workspaceId}/domain/verify`);
    expect(init?.method).toBe("POST");
  });

  it("releases the hostname with DELETE and accepts a null domain", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ domain: null }));

    await expect(removeWorkspaceDomain(workspaceId)).resolves.toEqual({
      ok: true,
      data: { domain: null },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/workspaces/${workspaceId}/domain`);
    expect(init?.method).toBe("DELETE");
  });

  it("treats an off-contract body as invalid rather than casting it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ domain: { hostname: "notes.example.com" } }));

    await expect(loadWorkspaceDomain(workspaceId)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("surfaces DOMAIN_TAKEN from a 409 so the remedy can be specific", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "DOMAIN_TAKEN", message: "taken" } }, 409),
    );

    await expect(setWorkspaceDomain(workspaceId, "notes.example.com")).resolves.toEqual({
      ok: false,
      kind: "conflict",
      code: "DOMAIN_TAKEN",
    });
  });

  it("fails closed on a bad workspace id or hostname, without fetching", async () => {
    await expect(loadWorkspaceDomain("not-a-uuid")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(verifyWorkspaceDomain("not-a-uuid")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(removeWorkspaceDomain("not-a-uuid")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(setWorkspaceDomain(workspaceId, "http://notes.example.com/x")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
