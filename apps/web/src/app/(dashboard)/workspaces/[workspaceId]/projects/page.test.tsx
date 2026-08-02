import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/projects/server-projects", () => ({ getServerProjectList: vi.fn() }));
vi.mock("@/lib/workspaces/server-workspaces", () => ({ getServerWorkspaceDetail: vi.fn() }));

import ProjectsPage from "@/app/(dashboard)/workspaces/[workspaceId]/projects/page";
import { getServerProjectList } from "@/lib/projects/server-projects";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const workspace = {
  id: workspaceId,
  name: "Acme",
  slug: "acme",
  description: null,
  plan: "free",
  currentUserRole: "viewer",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "a4" },
  storageLimitBytes: null,
  createdById: "30000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as const;
const query = {
  page: 1,
  limit: 12,
  status: undefined,
  name: undefined,
  sortBy: "updatedAt",
  sortDirection: "desc",
} as const;

describe("project list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });
  });

  it("distinguishes first-page filtered empty and role presentation", async () => {
    vi.mocked(getServerProjectList).mockResolvedValue({
      status: "ready",
      data: { items: [], page: 1, limit: 12, hasMore: false },
      query: { ...query, name: "missing" },
    });
    render(
      await ProjectsPage({
        params: Promise.resolve({ workspaceId }),
        searchParams: Promise.resolve({ name: "missing" }),
      }),
    );
    expect(screen.getByRole("heading", { name: "No matching projects" })).toBeVisible();
    expect(screen.getByRole("note")).toHaveTextContent(/owner or admin/i);
  });

  it("distinguishes a past-end page and preserves a first-page link", async () => {
    vi.mocked(getServerProjectList).mockResolvedValue({
      status: "ready",
      data: { items: [], page: 3, limit: 12, hasMore: false },
      query: { ...query, page: 3 },
    });
    render(
      await ProjectsPage({
        params: Promise.resolve({ workspaceId }),
        searchParams: Promise.resolve({ page: "3" }),
      }),
    );
    expect(screen.getByRole("heading", { name: "No projects on this page" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Return to the first page" })).toHaveAttribute(
      "href",
      expect.not.stringContaining("page=3"),
    );
  });

  it("renders retry for unavailable and conceals not-found workspace access", async () => {
    vi.mocked(getServerProjectList).mockResolvedValue({ status: "unavailable" });
    render(await ProjectsPage({ params: Promise.resolve({ workspaceId }) }));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded safely/i);
    vi.mocked(getServerProjectList).mockResolvedValue({ status: "not-found" });
    await expect(ProjectsPage({ params: Promise.resolve({ workspaceId }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
