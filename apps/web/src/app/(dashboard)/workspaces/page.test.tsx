import { render, screen, within } from "@testing-library/react";
import { cookies } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspacePage } from "@notted/shared-types";

import WorkspacesPage from "@/app/(dashboard)/workspaces/page";
import { getServerWorkspaceList } from "@/lib/workspaces/server-workspaces";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/shell/requests", () => ({ selectWorkspace: vi.fn() }));
vi.mock("@/lib/workspaces/requests", () => ({
  createWorkspace: vi.fn(),
  suggestSlugFromName: vi.fn(() => ""),
}));
vi.mock("@/lib/workspaces/server-workspaces", () => ({ getServerWorkspaceList: vi.fn() }));

const items: WorkspacePage = {
  items: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      name: "Acme Design",
      slug: "acme-design",
      description: "Brand workspace",
      plan: "pro",
      currentUserRole: "owner",
      logoUrl: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      name: "Beta Notes",
      slug: "beta-notes",
      description: null,
      plan: "free",
      currentUserRole: "editor",
      logoUrl: null,
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
  ],
  page: 1,
  limit: 25,
  hasMore: false,
};

function mockNoSelection(): void {
  vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);
}

describe("workspaces list page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the authorized workspace memberships as links", async () => {
    mockNoSelection();
    vi.mocked(getServerWorkspaceList).mockResolvedValue({ status: "ready", data: items });
    const ui = await WorkspacesPage();
    render(ui);

    expect(getServerWorkspaceList).toHaveBeenCalledWith({ page: 1, limit: 25 });
    expect(screen.getByRole("heading", { level: 1, name: "Workspaces" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Your workspaces" });
    expect(within(list).getByText("Acme Design")).toBeVisible();
    expect(within(list).getByText("acme-design")).toBeVisible();
    expect(within(list).getByText("Beta Notes")).toBeVisible();
    const acmeLink = screen.getByRole("link", { name: /Open Acme Design workspace/i });
    expect(acmeLink).toHaveAttribute("href", "/workspaces/30000000-0000-4000-8000-000000000001");
  });

  it("renders an empty state without fabricating workspaces", async () => {
    mockNoSelection();
    vi.mocked(getServerWorkspaceList).mockResolvedValue({
      status: "ready",
      data: { items: [], page: 1, limit: 25, hasMore: false },
    });
    const ui = await WorkspacesPage();
    render(ui);

    expect(screen.getByRole("heading", { name: "No workspaces yet" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your workspaces" })).not.toBeInTheDocument();
  });

  it.each(["unavailable", "unauthenticated"] as const)(
    "conceals all workspace data when the list is %s",
    async (status) => {
      mockNoSelection();
      vi.mocked(getServerWorkspaceList).mockResolvedValue({ status });
      const ui = await WorkspacesPage();
      render(ui);

      expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded safely/i);
      expect(screen.queryByText("Acme Design")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Notes")).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Your workspaces" })).not.toBeInTheDocument();
    },
  );

  it("uses the bounded page selector and renders pagination links", async () => {
    mockNoSelection();
    vi.mocked(getServerWorkspaceList).mockResolvedValue({
      status: "ready",
      data: { ...items, page: 2, hasMore: true },
    });

    const ui = await WorkspacesPage({ searchParams: Promise.resolve({ page: "2" }) });
    render(ui);

    expect(getServerWorkspaceList).toHaveBeenCalledWith({ page: 2, limit: 25 });
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/workspaces?page=1",
    );
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "/workspaces?page=3",
    );
  });
});
