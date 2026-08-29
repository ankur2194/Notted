import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  // The sidebar mounts `TagFilterList`, which reads the tag filter out of the
  // query string. Production wraps it in `<Suspense>`; the mock has to supply
  // the hook regardless or every dashboard-layout case throws on render.
  useSearchParams: () => new URLSearchParams(),
}));
// The layout reads two request headers: the pathname `proxy.ts` stamps on (so a
// login redirect can return the visitor to the page they asked for) and the
// host (so a tenant's custom domain does not offer a workspace switch that its
// own guards refuse).
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: (name: string) => requestHeaders.get(name) ?? null }),
  // `WorkspaceThemeStyle` deep in the shell reads the selection cookie.
  cookies: () => Promise.resolve({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("@/lib/auth/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/shell/server-shell", () => ({ getServerShell: vi.fn() }));

import DashboardLayout from "@/app/(dashboard)/layout";
import { getServerSession } from "@/lib/auth/server-session";
import { getServerShell } from "@/lib/shell/server-shell";
import { PATHNAME_HEADER } from "@/proxy";

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

const membership = {
  workspaceId: "00000000-0000-4000-8100-000000000001",
  name: "Alpha",
  slug: "alpha",
  role: "owner" as const,
  logoUrl: null,
  accentColor: null,
};

const authenticated = {
  status: "authenticated" as const,
  principal: {
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: "session-id",
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    expiresAt: "2026-07-30T00:00:00.000Z",
    authenticatedAt: "2026-07-29T00:00:00.000Z",
    isFresh: true,
  },
};

describe("protected dashboard layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestHeaders.clear();
  });

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
    expect(screen.getByRole("button", { name: "User menu" })).toBeInTheDocument();
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

  it("returns the visitor to the page they asked for after signing in", async () => {
    // The App Router hands a layout no pathname, so both redirects sent every
    // visitor to `loginPathFor("/")` and lost the bookmarked note or the deep
    // link out of an email. `proxy.ts` stamps the path on the request.
    const path = "/workspaces/00000000-0000-4000-8100-000000000001/notes/n";
    requestHeaders.set(PATHNAME_HEADER, path);

    vi.mocked(getServerSession).mockResolvedValue({ status: "unauthenticated" });
    await expect(DashboardLayout({ children: <p>Protected</p> })).rejects.toThrow(
      `REDIRECT:/login?redirect=${encodeURIComponent(path)}`,
    );

    vi.mocked(getServerSession).mockResolvedValue(authenticated);
    vi.mocked(getServerShell).mockResolvedValue({ status: "unauthenticated" });
    await expect(DashboardLayout({ children: <p>Protected</p> })).rejects.toThrow(
      `REDIRECT:/login?redirect=${encodeURIComponent(path)}`,
    );
  });

  it("withholds the workspace switch on a tenant host, which always refuses it", async () => {
    // Two guards refuse a switch on a non-primary host -- the proxy 404s the
    // POST and the route handler requires the primary origin -- so rendering the
    // dropdown there offers an action that can only fail.
    vi.mocked(getServerSession).mockResolvedValue(authenticated);
    vi.mocked(getServerShell).mockResolvedValue({
      status: "ready",
      data: { ...shell, workspaces: [membership], currentWorkspace: membership },
    });

    requestHeaders.set("host", "localhost:3000");
    const primary = render(await DashboardLayout({ children: <p>Protected</p> }));
    expect(primary.container.querySelector("select#workspace-switcher")).not.toBeNull();
    primary.unmount();

    requestHeaders.set("x-forwarded-host", "notes.acme.example");
    const tenant = render(await DashboardLayout({ children: <p>Protected</p> }));
    expect(tenant.container.querySelector("select#workspace-switcher")).toBeNull();
    expect(tenant.getByTestId("workspace-switcher-static")).toHaveTextContent("Alpha");
  });
});
