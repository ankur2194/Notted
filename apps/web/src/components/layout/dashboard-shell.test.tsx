import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardShell } from "./DashboardShell";

import type { ShellBootstrap } from "@notted/shared-types";

import {
  loadNotifications,
  markAllNotificationsRead,
  setNotificationRead,
} from "@/lib/shell/requests";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/shell/requests", () => ({
  loadNotifications: vi.fn().mockResolvedValue({
    ok: true,
    data: { items: [], page: 1, limit: 20, hasMore: false, unreadCount: 0 },
  }),
  markAllNotificationsRead: vi.fn(),
  setNotificationRead: vi.fn(),
  selectWorkspace: vi.fn(),
}));
vi.mock("@/lib/auth/requests", () => ({ signOut: vi.fn().mockResolvedValue({ ok: true }) }));

const workspaceId = "20000000-0000-4000-8000-000000000001";
const shell: ShellBootstrap = {
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Ada Editor",
    email: "ada@example.test",
  },
  workspaces: [{ workspaceId, name: "Alpha", slug: "alpha", role: "editor" }],
  currentWorkspace: { workspaceId, name: "Alpha", slug: "alpha", role: "editor" },
  permissions: {
    canViewSettings: true,
    canManageWorkspace: false,
    canManageMembers: false,
    canCreateContent: true,
  },
  notificationUnreadCount: 1,
};

describe("DashboardShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("provides landmarks, permission-aware navigation, placeholders and a mobile focus trap", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell}>
        <h1>Dashboard content</h1>
      </DashboardShell>,
    );
    expect(screen.getByRole("main")).toHaveTextContent("Dashboard content");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText(/note tree unavailable until Parts 31–32/i)).toBeInTheDocument();
    expect(screen.queryByText("Workspace settings")).toHaveAttribute("aria-disabled", "true");
    const open = screen.getByRole("button", { name: "Open navigation" });
    await user.click(open);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(open).toHaveFocus();
  });

  it("opens command placeholder with Ctrl+K and closes the user menu with Escape", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell}>
        <p>Content</p>
      </DashboardShell>,
    );
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command menu" })).toHaveTextContent(/Parts 50–52/);
    await user.keyboard("{Escape}");
    const userMenu = screen.getByRole("button", { name: "Open user menu" });
    await user.click(userMenu);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(userMenu).toHaveFocus();
  });

  it("loads real notifications and persists one/all read actions through typed requests", async () => {
    const notification = {
      id: "25000000-0000-4000-8000-000000000001",
      workspaceId,
      kind: "system" as const,
      actorId: null,
      targetType: "workspace" as const,
      targetId: workspaceId,
      summary: "Policy changed",
      targetLabel: "Alpha",
      createdAt: "2026-07-30T10:00:00.000Z",
      readAt: null,
    };
    vi.mocked(loadNotifications).mockResolvedValue({
      ok: true,
      data: { items: [notification], page: 1, limit: 20, hasMore: false, unreadCount: 1 },
    });
    vi.mocked(setNotificationRead).mockResolvedValue({
      ok: true,
      data: {
        notification: { ...notification, readAt: "2026-07-30T11:00:00.000Z" },
        unreadCount: 1,
      },
    });
    vi.mocked(markAllNotificationsRead).mockResolvedValue({
      ok: true,
      data: { updatedCount: 1, unreadCount: 0 },
    });
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell}>
        <p>Content</p>
      </DashboardShell>,
    );
    await user.click(screen.getByRole("button", { name: /Notifications, 1 unread/ }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await user.click(within(dialog).getByRole("button", { name: "Mark read: Policy changed" }));
    expect(setNotificationRead).toHaveBeenCalledWith(workspaceId, notification.id, true);
    await user.click(within(dialog).getByRole("button", { name: "Mark all read" }));
    expect(markAllNotificationsRead).toHaveBeenCalledWith(workspaceId);
  });
});
