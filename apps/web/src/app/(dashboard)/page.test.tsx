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

import DashboardPage from "@/app/(dashboard)/page";

describe("dashboard home", () => {
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
