import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/auth/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/shell/server-shell", () => ({ getServerShell: vi.fn() }));

import DashboardLayout from "@/app/(dashboard)/layout";
import { getServerSession } from "@/lib/auth/server-session";
import { getServerShell } from "@/lib/shell/server-shell";

const shell = {
  user: { id: "00000000-0000-4000-8000-000000000001", name: "Ada", email: "ada@example.test" },
  workspaces: [],
  currentWorkspace: null,
  permissions: {
    canViewSettings: false,
    canManageWorkspace: false,
    canManageMembers: false,
    canCreateContent: false,
  },
  notificationUnreadCount: 0,
};

describe("protected dashboard layout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects an unauthenticated direct request to login with a local return path", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ status: "unauthenticated" });
    await expect(DashboardLayout({ children: <p>Protected</p> })).rejects.toThrow(
      "REDIRECT:/login?redirect=%2F",
    );
  });

  it("fails closed with a retry state when session validation is unavailable", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ status: "unavailable" });
    render(await DashboardLayout({ children: <p>Secret protected content</p> }));
    expect(screen.getByRole("alert")).toHaveTextContent("Session validation unavailable");
    expect(screen.queryByText("Secret protected content")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Retry" })).toHaveAttribute("href", "/");
  });

  it("renders protected content and logout only for an authenticated principal", async () => {
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
    vi.mocked(getServerShell).mockResolvedValue({ status: "ready", data: shell });
    render(await DashboardLayout({ children: <p>Protected</p> }));
    expect(screen.getByText("Protected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open user menu" })).toBeInTheDocument();
  });

  it("fails closed when memberships and notification count cannot be loaded", async () => {
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
    vi.mocked(getServerShell).mockResolvedValue({ status: "unavailable" });
    render(await DashboardLayout({ children: <p>Protected</p> }));
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace shell unavailable");
    expect(screen.queryByText("Protected")).not.toBeInTheDocument();
  });
});
