import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail, WorkspaceStorageUsage } from "@notted/shared-types";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/workspaces/server-workspaces", () => ({
  getServerWorkspaceDetail: vi.fn(),
  getServerWorkspaceStorageUsage: vi.fn(),
}));

import WorkspaceOverviewPage from "@/app/(dashboard)/workspaces/[workspaceId]/page";
import {
  getServerWorkspaceDetail,
  getServerWorkspaceStorageUsage,
} from "@/lib/workspaces/server-workspaces";

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

/**
 * Part 45 usage fixture. Deliberately avoids formatting to "1 GiB" or
 * "1,073,741,824 bytes", which the Part 26 storage-limit override assertions
 * below match with `getByText` — a collision would fail them on ambiguity.
 */
const storageUsage = {
  workspaceId: workspace.id,
  plan: "pro",
  usedBytes: 536_870_912, // 512 MiB — 25% of the limit
  pendingBytes: 0,
  limitBytes: 2_147_483_648, // 2 GiB
  availableBytes: 1_610_612_736,
  attachmentCount: 3,
  limitSource: "plan",
} satisfies WorkspaceStorageUsage;

function renderPage() {
  return WorkspaceOverviewPage({ params: Promise.resolve({ workspaceId: workspace.id }) });
}

describe("workspace overview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, including queued one-shots, so the
    // loader mocks are reset explicitly. `notFound` is only cleared, never
    // reset, because its throwing implementation is what the concealment tests
    // assert against.
    vi.mocked(getServerWorkspaceDetail).mockReset();
    vi.mocked(getServerWorkspaceStorageUsage).mockReset();
    vi.mocked(getServerWorkspaceStorageUsage).mockResolvedValue({
      status: "ready",
      data: storageUsage,
    });
  });

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

  it("renders the server-measured storage usage bar alongside the limit", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });

    render(await renderPage());

    // The overview is a Server Component, so usage arrives already resolved —
    // there is no client boundary and no loading state to pass through.
    const bar = screen.getByRole("progressbar", { name: "Storage used" });
    expect(bar).toHaveAttribute("aria-valuenow", "536870912");
    expect(bar).toHaveAttribute("aria-valuemax", "2147483648");
    expect(bar).toHaveAttribute("aria-valuetext", "536,870,912 bytes of 2,147,483,648 bytes used.");
    expect(screen.getByTestId("storage-used-segment")).toHaveStyle({ width: "25%" });
    expect(screen.getByText("Limit of 2 GiB from the pro plan default.")).toBeVisible();
    expect(screen.getByText("(3 files)")).toBeVisible();
    // The Part 26 override figure is untouched by the new usage display.
    expect(screen.getByText("1 GiB")).toBeVisible();
  });

  it("degrades the storage card alone when usage is unavailable", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });
    vi.mocked(getServerWorkspaceStorageUsage).mockResolvedValue({ status: "unavailable" });

    render(await renderPage());

    expect(screen.getByText(/Storage usage could not be loaded/i)).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    // The rest of the page still renders; one failed aggregate is not fatal.
    expect(screen.getByRole("heading", { level: 1, name: workspace.name })).toBeVisible();
    expect(screen.getByText("1 GiB")).toBeVisible();
  });

  it("states a usage denial as a permission fact, not a failure", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });
    vi.mocked(getServerWorkspaceStorageUsage).mockResolvedValue({ status: "forbidden" });

    render(await renderPage());

    expect(screen.getByText(/not available for your access/i)).toBeVisible();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders an exhausted quota with non-visual wording", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });
    vi.mocked(getServerWorkspaceStorageUsage).mockResolvedValue({
      status: "ready",
      data: { ...storageUsage, usedBytes: storageUsage.limitBytes, availableBytes: 0 },
    });

    render(await renderPage());

    expect(
      screen.getByText("Storage full. New uploads are rejected until files are removed."),
    ).toBeVisible();
    expect(screen.getByTestId("storage-used-segment")).toHaveStyle({ width: "100%" });
  });

  it("names a per-workspace override as the limit in force", async () => {
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });
    vi.mocked(getServerWorkspaceStorageUsage).mockResolvedValue({
      status: "ready",
      data: { ...storageUsage, limitSource: "override" },
    });

    render(await renderPage());

    expect(
      screen.getByText("Limit of 2 GiB set for this workspace, overriding the pro plan default."),
    ).toBeVisible();
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
