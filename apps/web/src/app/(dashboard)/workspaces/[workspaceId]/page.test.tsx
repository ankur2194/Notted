import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail } from "@notted/shared-types";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/workspaces/server-workspaces", () => ({ getServerWorkspaceDetail: vi.fn() }));

import WorkspaceOverviewPage from "@/app/(dashboard)/workspaces/[workspaceId]/page";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

const workspace = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Acme Design",
  slug: "acme-design",
  description: "Brand workspace",
  plan: "pro",
  currentUserRole: "viewer",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "letter" },
  storageLimitBytes: 1_073_741_824,
  createdById: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceDetail;

function renderPage() {
  return WorkspaceOverviewPage({ params: Promise.resolve({ workspaceId: workspace.id }) });
}

describe("workspace overview page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders authorized identity, plan, quota, role, and page-default summaries", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });

    render(await renderPage());

    expect(screen.getByRole("heading", { level: 1, name: workspace.name })).toBeVisible();
    expect(screen.getByText("Brand workspace")).toBeVisible();
    expect(screen.getByText("Storage limit override")).toBeVisible();
    expect(screen.getByText("1 GiB")).toBeVisible();
    expect(screen.getByText("1,073,741,824 bytes")).toHaveClass("sr-only");
    expect(screen.getByRole("heading", { name: "Page defaults" })).toBeVisible();
    expect(screen.getByText("Letter")).toBeVisible();
    expect(screen.getByRole("link", { name: "View settings" })).toHaveAttribute(
      "href",
      `/workspaces/${workspace.id}/settings`,
    );
  });

  it("renders a null storage override as the real plan-managed state", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({
      status: "ready",
      data: { ...workspace, storageLimitBytes: null },
    });

    render(await renderPage());

    expect(screen.getByText("Plan-managed limit")).toBeVisible();
    expect(screen.queryByText(/not exposed|not available/i)).not.toBeInTheDocument();
  });

  it.each(["not-found", "unauthenticated"] as const)(
    "conceals workspace details for the %s state",
    async (status) => {
      vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status });

      await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalled();
    },
  );

  it("renders a safe unavailable state without workspace data", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "unavailable" });

    render(await renderPage());

    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded safely/i);
    expect(screen.queryByText(workspace.name)).not.toBeInTheDocument();
  });
});
