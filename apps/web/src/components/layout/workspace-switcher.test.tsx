import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/shell/requests", () => ({ selectWorkspace: vi.fn() }));

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

import { selectWorkspace } from "@/lib/shell/requests";

const alpha = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  name: "Alpha",
  slug: "alpha",
  role: "editor" as const,
};
const beta = {
  workspaceId: "20000000-0000-4000-8000-000000000002",
  name: "Beta",
  slug: "beta",
  role: "viewer" as const,
};

describe("WorkspaceSwitcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not fabricate a workspace in the zero-workspace state", () => {
    render(<WorkspaceSwitcher workspaces={[]} currentWorkspace={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("No workspace access");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("disables a one-workspace selector", () => {
    render(<WorkspaceSwitcher workspaces={[alpha]} currentWorkspace={alpha} />);
    expect(screen.getByRole("combobox", { name: "Current workspace" })).toBeDisabled();
    expect(screen.getByText("Only one workspace is available.")).toBeInTheDocument();
  });

  it("shows a retryable error without changing workspace on denied selection", async () => {
    vi.mocked(selectWorkspace).mockResolvedValue({ ok: false, kind: "forbidden" });
    const user = userEvent.setup();
    render(<WorkspaceSwitcher workspaces={[alpha, beta]} currentWorkspace={alpha} />);
    await user.selectOptions(screen.getByRole("combobox"), beta.workspaceId);
    expect(selectWorkspace).toHaveBeenCalledWith(beta.workspaceId);
    expect(screen.getByRole("alert")).toHaveTextContent(/access changed/i);
  });
});
