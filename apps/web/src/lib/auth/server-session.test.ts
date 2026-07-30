import { cookies } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServerSession } from "@/lib/auth/server-session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const principal = {
  userId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-id",
  method: "opaque-session",
  assurance: "single-factor",
  expiresAt: "2026-07-30T00:00:00.000Z",
  authenticatedAt: "2026-07-29T00:00:00.000Z",
  isFresh: true,
};

describe("getServerSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [
        { name: "better-auth.session_token", value: "opaque-secret" },
        { name: "theme", value: "light" },
      ],
    } as never);
  });

  it("forwards cookies without caching and returns the safe principal", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(principal), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(getServerSession()).resolves.toEqual({ status: "authenticated", principal });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/auth/session", "http://localhost:3001"),
      expect.objectContaining({
        cache: "no-store",
        headers: { cookie: "better-auth.session_token=opaque-secret; theme=light" },
      }),
    );
  });

  it.each([401, 403])("treats %s as unauthenticated", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    await expect(getServerSession()).resolves.toEqual({ status: "unauthenticated" });
  });

  it("fails closed on malformed responses and network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ userId: "unsafe-partial" }), { status: 200 }),
    );
    await expect(getServerSession()).resolves.toEqual({ status: "unavailable" });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("cookie opaque-secret"));
    await expect(getServerSession()).resolves.toEqual({ status: "unavailable" });
  });
});
