import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { breadcrumbsFor, DashboardShell } from "./DashboardShell";

import type { ShellBootstrap } from "@notted/shared-types";

import {
  loadNotifications,
  markAllNotificationsRead,
  setNotificationRead,
} from "@/lib/shell/requests";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  // The sidebar tag filter reads the active tag from the search params.
  useSearchParams: () => new URLSearchParams(),
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
  workspaces: [
    { workspaceId, name: "Alpha", slug: "alpha", role: "editor", logoUrl: null, accentColor: null },
  ],
  currentWorkspace: {
    workspaceId,
    name: "Alpha",
    slug: "alpha",
    role: "editor",
    logoUrl: null,
    accentColor: null,
  },
  permissions: {
    canViewSettings: true,
    canManageWorkspace: false,
    canManageMembers: false,
    canCreateContent: true,
  },
  notificationUnreadCount: 1,
};
const noteNavigation = {
  status: "ready" as const,
  navigation: { items: [], limit: 500, returned: 0, truncated: false },
  folders: [],
};
const tagNavigation = { status: "ready" as const, tags: [], truncated: false };

describe("DashboardShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("provides canonical project breadcrumbs and disables project navigation without a workspace", () => {
    expect(breadcrumbsFor(`/workspaces/${workspaceId}/projects`)).toEqual([
      { label: "Workspaces", href: "/workspaces" },
      { label: "Overview", href: `/workspaces/${workspaceId}` },
      { label: "Projects" },
    ]);
    expect(breadcrumbsFor(`/workspaces/${workspaceId}/projects/project-id`)).toEqual([
      { label: "Workspaces", href: "/workspaces" },
      { label: "Overview", href: `/workspaces/${workspaceId}` },
      { label: "Projects", href: `/workspaces/${workspaceId}/projects` },
      { label: "Project detail" },
    ]);
    expect(breadcrumbsFor(`/workspaces/${workspaceId}/search`)).toEqual([
      { label: "Workspaces", href: "/workspaces" },
      { label: "Overview", href: `/workspaces/${workspaceId}` },
      { label: "Search" },
    ]);
    render(
      <DashboardShell
        shell={{ ...shell, currentWorkspace: null }}
        noteNavigation={{ status: "no-workspace" }}
        tagNavigation={{ status: "no-workspace" }}
      >
        <p>Content</p>
      </DashboardShell>,
    );
    expect(screen.getByText("Projects").closest("span[aria-disabled='true']")).toBeInTheDocument();
  });

  it("provides landmarks, permission-aware navigation, placeholders and a mobile focus trap", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <h1>Dashboard content</h1>
      </DashboardShell>,
    );
    expect(screen.getByRole("main")).toHaveTextContent("Dashboard content");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("No visible project notes.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workspaces" })).toHaveAttribute("href", "/workspaces");
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      `/workspaces/${workspaceId}/projects`,
    );
    expect(screen.getByRole("link", { name: "Workspace settings" })).toHaveAttribute(
      "href",
      `/workspaces/${workspaceId}/settings`,
    );
    const open = screen.getByRole("button", { name: "Open navigation" });
    await user.click(open);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(open).toHaveFocus();
  });

  it("opens the search palette with Ctrl+K and closes the user menu with Escape", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search notes" });
    expect(palette).toHaveTextContent(/Start typing to search/);
    await user.keyboard("{Escape}");
    const userMenu = screen.getByRole("button", { name: "User menu" });
    await user.click(userMenu);
    expect(userMenu).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(userMenu).toHaveAttribute("aria-expanded", "false");
    expect(userMenu).toHaveFocus();
  });

  it("opens the user menu as a disclosure and closes it on a click outside", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    const trigger = screen.getByRole("button", { name: "User menu" });
    // A `role="menu"` promises the APG arrow-key model. Nothing here implements
    // it, so nothing here claims it — this replaces an assertion that used to
    // require the broken pattern.
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId!);
    expect(panel).not.toBeNull();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(within(panel!).getByRole("link", { name: "Security settings" })).toBeVisible();

    await user.click(screen.getByText("Content"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(panelId!)).toBeNull();
  });

  it("leaves Ctrl+K alone when a nearer binding already claimed it", async () => {
    const user = userEvent.setup();
    // Stands in for the editor's `Mod-k` link chord: a listener between the
    // keystroke and the document calls `preventDefault`, so the global search
    // palette must not also fire.
    function LinkChord() {
      return (
        <div
          data-testid="editor-surface"
          role="textbox"
          aria-label="Note content"
          tabIndex={-1}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
              event.preventDefault();
            }
          }}
        >
          Content
        </div>
      );
    }
    render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <LinkChord />
      </DashboardShell>,
    );
    screen.getByTestId("editor-surface").focus();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Search notes" })).not.toBeInTheDocument();
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
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
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

  /**
   * The Part 34 rule inside a dialog, where breaking it is worst: pressing "Mark
   * all read" is itself what makes the control unavailable, so a native
   * `disabled` would remove it from the tab order under the reader's own
   * keypress and drop focus onto `<body>` — inside a modal, with nothing left
   * for `Escape` to return to.
   */
  it("keeps 'Mark all read' focusable and inert when there is nothing to mark", async () => {
    vi.mocked(loadNotifications).mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 20, hasMore: false, unreadCount: 0 },
    });
    const user = userEvent.setup();
    render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );

    await user.click(screen.getByRole("button", { name: /Notifications, 1 unread/ }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    const markAll = within(dialog).getByRole("button", { name: "Mark all read" });

    await waitFor(() => expect(markAll).toHaveAttribute("aria-disabled", "true"));
    expect(markAll).not.toHaveAttribute("disabled");
    markAll.focus();
    await user.click(markAll);
    expect(markAll).toHaveFocus();
    expect(markAllNotificationsRead).not.toHaveBeenCalled();
  });
  // ------------------------------------------------------------------- //
  // Part 72 — branding.
  // ------------------------------------------------------------------- //

  it("emits no accent custom properties when the workspace has no accent", () => {
    const { container } = render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    const root = container.querySelector("div.min-h-dvh");
    expect(root?.getAttribute("style")).toBeNull();
  });

  it("overrides --color-primary and --color-ring from the workspace accent", () => {
    const branded: ShellBootstrap = {
      ...shell,
      currentWorkspace:
        shell.currentWorkspace === null
          ? null
          : { ...shell.currentWorkspace, accentColor: "#0f766e" },
    };
    const { container } = render(
      <DashboardShell shell={branded} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    const style = container.querySelector("div.min-h-dvh")?.getAttribute("style") ?? "";
    expect(style).toContain("--color-primary: #0f766e");
    expect(style).toContain("--color-ring: #0f766e");
  });

  it("ignores an accent that is not a six-digit hex colour", () => {
    const hostile: ShellBootstrap = {
      ...shell,
      currentWorkspace:
        shell.currentWorkspace === null
          ? null
          : { ...shell.currentWorkspace, accentColor: "red;} :root{--color-primary:blue" },
    };
    const { container } = render(
      <DashboardShell shell={hostile} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    expect(container.querySelector("div.min-h-dvh")?.getAttribute("style")).toBeNull();
  });

  it("shows the Notted mark when the workspace has no logo", () => {
    render(
      <DashboardShell shell={shell} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    const home = screen.getAllByRole("link", { name: "Notted dashboard" })[0];
    expect(home).toHaveTextContent("Notted");
    expect(within(home as HTMLElement).queryByRole("img")).toBeNull();
  });

  it("shows the workspace logo and name when one is published", () => {
    const branded: ShellBootstrap = {
      ...shell,
      currentWorkspace:
        shell.currentWorkspace === null
          ? null
          : {
              ...shell.currentWorkspace,
              logoUrl: `/api/v1/workspaces/${workspaceId}/logo/0123456789abcdef0123456789abcdef`,
            },
    };
    render(
      <DashboardShell shell={branded} noteNavigation={noteNavigation} tagNavigation={tagNavigation}>
        <p>Content</p>
      </DashboardShell>,
    );
    const home = screen.getAllByRole("link", { name: "Notted dashboard" })[0];
    expect(home).toHaveTextContent("Alpha");
    const logo = within(home as HTMLElement).getByRole("img", { name: "Alpha logo" });
    expect(logo.getAttribute("src")).toContain(
      `/api/v1/workspaces/${workspaceId}/logo/0123456789abcdef0123456789abcdef`,
    );
  });
});
