import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shell/server-shell", () => ({
  getServerShell: vi.fn().mockResolvedValue({
    status: "ready",
    data: { currentWorkspace: null, permissions: { canCreateContent: false } },
  }),
}));
vi.mock("@/lib/notes/server-notes", () => ({
  getServerNoteList: vi.fn(),
  getServerFolders: vi.fn(),
}));
// A client component with TanStack Query hooks: mounting it here would need the
// shell's `ReactQueryProvider`, which this page-level test does not render.
vi.mock("@/components/tasks/MyTasksWidget", () => ({ MyTasksWidget: () => null }));

import DashboardPage from "@/app/(dashboard)/page";
import { getServerFolders, getServerNoteList } from "@/lib/notes/server-notes";
import { getServerShell } from "@/lib/shell/server-shell";

const WORKSPACE_ID = "40000000-0000-4000-8000-000000000001";

describe("dashboard home", () => {
  it("overlaps the two workspace reads instead of awaiting them in turn", async () => {
    // Serially awaited, the page paid both round trips end to end for data
    // neither call needs from the other.
    // `Once`, so the module-level default (no workspace) still stands for the
    // sibling test whichever order they run in.
    vi.mocked(getServerShell).mockResolvedValueOnce({
      status: "ready",
      data: {
        currentWorkspace: { workspaceId: WORKSPACE_ID, name: "Alpha", role: "owner" },
        user: { id: "40000000-0000-4000-8000-000000000002" },
        permissions: { canCreateContent: true },
      },
    } as never);

    let inFlight = 0;
    let peak = 0;
    const pending = (result: unknown) => () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return Promise.resolve().then(() => {
        inFlight -= 1;
        return result;
      });
    };
    vi.mocked(getServerNoteList).mockImplementation(pending({ status: "unavailable" }) as never);
    vi.mocked(getServerFolders).mockImplementation(pending({ status: "unavailable" }) as never);

    render(await DashboardPage());

    expect(peak).toBeGreaterThan(1);
  });

  it("renders one honest heading hierarchy without the obsolete demo", async () => {
    render(await DashboardPage());
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Workspace content" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Browse standalone notes, folders/i)).toBeInTheDocument();
    expect(screen.queryByText(/interactive demo/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open ui preview/i })).not.toBeInTheDocument();
  });
});
