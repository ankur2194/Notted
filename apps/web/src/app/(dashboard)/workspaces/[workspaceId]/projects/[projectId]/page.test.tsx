import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetail, WorkspaceDetail } from "@notted/shared-types";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  notFound,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/projects/server-projects", () => ({ getServerProjectDetail: vi.fn() }));
vi.mock("@/lib/workspaces/server-workspaces", () => ({ getServerWorkspaceDetail: vi.fn() }));
vi.mock("@/lib/notes/server-notes", () => ({
  getServerNoteList: vi.fn(),
  getServerFolders: vi.fn(),
}));
vi.mock("@/components/notes/NoteBrowser", () => ({ NoteBrowser: () => <h2>Project notes</h2> }));
vi.mock("@/lib/projects/requests", () => ({
  updateProject: vi.fn(),
  transitionProject: vi.fn(),
  deleteProject: vi.fn(),
}));

import ProjectDetailPage from "@/app/(dashboard)/workspaces/[workspaceId]/projects/[projectId]/page";
import { getServerFolders, getServerNoteList } from "@/lib/notes/server-notes";
import { getServerProjectDetail } from "@/lib/projects/server-projects";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000002";
const project = {
  id: projectId,
  workspaceId,
  name: "Launch",
  description: "Release plan",
  coverImageUrl: "/api/v1/attachments/30000000-0000-4000-8000-000000000004",
  color: "#3b82f6",
  status: "active",
  isArchived: false,
  isRestricted: false,
  dueAt: "2026-08-10T00:00:00.000Z",
  createdById: "30000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  lastActivityAt: "2026-08-03T00:00:00.000Z",
  members: [
    {
      userId: "30000000-0000-4000-8000-000000000003",
      name: "Ada",
      avatarUrl: null,
      workspaceRole: "owner",
      projectRole: null,
      accessSource: "workspace-admin",
    },
  ],
  taskProgress: { coverage: "standalone-tasks", completed: 2, total: 3 },
} satisfies ProjectDetail;
const workspace = {
  id: workspaceId,
  name: "Acme",
  slug: "acme",
  description: null,
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "a4" },
  storageLimitBytes: null,
  createdById: project.createdById,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
} satisfies WorkspaceDetail;

describe("project detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerWorkspaceDetail).mockResolvedValue({ status: "ready", data: workspace });
    vi.mocked(getServerNoteList).mockResolvedValue({
      status: "ready",
      data: {
        page: { items: [], page: 1, limit: 50, hasMore: false },
        query: {
          page: 1,
          limit: 50,
          scope: "project",
          projectId,
          view: "normal",
          sortBy: "sortOrder",
          sortDirection: "asc",
        },
      },
    });
    vi.mocked(getServerFolders).mockResolvedValue({
      status: "ready",
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
  });

  it("renders real detail projection, honest cover/progress, authorized members, and bounded notes region", async () => {
    vi.mocked(getServerProjectDetail).mockResolvedValue({ status: "ready", data: project });
    render(await ProjectDetailPage({ params: Promise.resolve({ workspaceId, projectId }) }));
    expect(screen.getByRole("heading", { level: 1, name: "Launch" })).toBeVisible();
    expect(screen.getByText("2/3")).toBeVisible();
    expect(screen.getByText("Ada")).toBeVisible();
    expect(screen.getByText(/Cover attached/)).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project notes" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Project notes" })).toBeVisible();
  });

  it("maps concealed detail to not-found and unavailable to a retry state", async () => {
    vi.mocked(getServerProjectDetail).mockResolvedValue({ status: "not-found" });
    await expect(
      ProjectDetailPage({ params: Promise.resolve({ workspaceId, projectId }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getServerProjectDetail).mockResolvedValue({ status: "unavailable" });
    render(await ProjectDetailPage({ params: Promise.resolve({ workspaceId, projectId }) }));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded safely/i);
  });
});
