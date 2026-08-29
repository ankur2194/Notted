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
  logoUrl: null,
  accentColor: null,
};
const beta = {
  workspaceId: "20000000-0000-4000-8000-000000000002",
  name: "Beta",
  slug: "beta",
  role: "viewer" as const,
  logoUrl: null,
  accentColor: null,
};

describe("WorkspaceSwitcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not fabricate a workspace in the zero-workspace state", () => {
    render(<WorkspaceSwitcher workspaces={[]} currentWorkspace={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("No workspace access");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View workspaces" })).toHaveAttribute(
      "href",
      "/workspaces",
    );
  });

  it("shows a static label instead of a control that cannot work on a tenant host", () => {
    /*
     * On a workspace's own custom domain the switch is refused twice over, both
     * correctly: the proxy 404s `POST /api/shell/workspace` on a non-primary
     * host, and the route handler requires the primary origin. The dropdown was
     * still rendered, so every attempt ended in "Workspace access changed or the
     * server is unavailable" -- a permissions error the visitor cannot act on,
     * for something that was never going to work.
     */
    render(
      <WorkspaceSwitcher workspaces={[alpha, beta]} currentWorkspace={alpha} canSwitch={false} />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeVisible();
    // And it says where the switch does work, rather than just refusing.
    expect(screen.getByRole("link")).toHaveAttribute("href", expect.stringContaining("http"));
    expect(selectWorkspace).not.toHaveBeenCalled();
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
