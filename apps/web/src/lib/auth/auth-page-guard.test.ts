import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { redirectAuthenticatedFromAuthPage } from "@/lib/auth/auth-page-guard";
import { getServerSession } from "@/lib/auth/server-session";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/server-session", () => ({ getServerSession: vi.fn() }));

describe("redirectAuthenticatedFromAuthPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects an authenticated user before rendering an entry form", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      status: "authenticated",
      principal: {
        userId: "00000000-0000-4000-8000-000000000001",
        sessionId: "session-id",
        method: "opaque-session",
        assurance: "single-factor",
        expiresAt: "2026-07-30T00:00:00.000Z",
        authenticatedAt: "2026-07-29T00:00:00.000Z",
        isFresh: true,
      },
    });
    await redirectAuthenticatedFromAuthPage("/workspaces?view=recent");
    expect(redirect).toHaveBeenCalledWith("/workspaces?view=recent");
  });

  it.each(["unauthenticated", "unavailable"] as const)(
    "does not redirect a %s user",
    async (status) => {
      vi.mocked(getServerSession).mockResolvedValue({ status });
      await redirectAuthenticatedFromAuthPage();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});
