import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { headersStore } = vi.hoisted(() => ({
  headersStore: { get: vi.fn<(name: string) => string | null>(() => null) },
}));
vi.mock("next/headers", () => ({ headers: vi.fn(() => Promise.resolve(headersStore)) }));

import { getPublicNote } from "./server-public-note";

const token = "a".repeat(32);

const publicNote = {
  title: "Shared note",
  content: { type: "doc", content: [] },
  pageSize: "a4",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getPublicNote", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    headersStore.get.mockReset().mockReturnValue(null);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("forwards the incoming x-forwarded-for chain verbatim as X-Forwarded-For", async () => {
    headersStore.get.mockImplementation((name: string) =>
      name === "x-forwarded-for" ? "203.0.113.7, 10.0.0.1" : null,
    );
    fetchMock.mockResolvedValue(jsonResponse(publicNote));

    await getPublicNote(token);

    // The whole chain, unmodified: picking an entry (e.g. left-most) is the
    // API's job, done by trusted hop count, not the web tier's — the
    // left-most entry is client-controlled and must not be pre-selected here.
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-forwarded-for")).toBe(
      "203.0.113.7, 10.0.0.1",
    );
  });

  it("omits the header when the incoming request carries no forwarded address", async () => {
    fetchMock.mockResolvedValue(jsonResponse(publicNote));

    await getPublicNote(token);

    expect(fetchMock.mock.calls[0]![1]?.headers).toBeUndefined();
  });

  it("still resolves the note normally", async () => {
    fetchMock.mockResolvedValue(jsonResponse(publicNote));

    await expect(getPublicNote(token)).resolves.toMatchObject({
      status: "ready",
      data: { title: "Shared note" },
    });
  });
});
