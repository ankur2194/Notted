import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail } from "@notted/shared-types";

import { CreateWorkspaceDialog } from "@/components/workspaces/CreateWorkspaceDialog";
import { selectWorkspace } from "@/lib/shell/requests";
import { createWorkspace } from "@/lib/workspaces/requests";

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/workspaces/requests", () => ({
  createWorkspace: vi.fn(),
  // Real suggestion logic so the slug field auto-fills from the name.
  suggestSlugFromName: (name: string) =>
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
}));
vi.mock("@/lib/shell/requests", () => ({ selectWorkspace: vi.fn() }));

const workspaceDetail = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Acme Design",
  slug: "acme-design",
  description: null,
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "a4" },
  storageLimitBytes: null,
  createdById: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceDetail;

describe("CreateWorkspaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(selectWorkspace).mockResolvedValue({ ok: true, data: true });
  });

  it("auto-suggests a slug from the name, creates, then selects and navigates", async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: { ...workspaceDetail, settings: { defaultPageSize: "letter" } },
        slug: "acme-design",
      },
    });
    render(<CreateWorkspaceDialog />);

    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Workspace name"), "Acme Design");
    await user.selectOptions(within(dialog).getByLabelText("Default page size"), "letter");
    // Slug auto-derived from the name without manual entry.
    expect(within(dialog).getByLabelText("Workspace slug")).toHaveValue("acme-design");

    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));

    await waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith(
        {
          name: "Acme Design",
          slug: "acme-design",
          description: null,
          settings: { defaultPageSize: "letter" },
        },
        expect.stringMatching(/^[0-9a-f-]{36}$/u),
      ),
    );
    // The FINAL slug is shown before navigation proceeds.
    expect(await screen.findByText("Workspace created.")).toBeVisible();
    expect(screen.getByText("acme-design")).toHaveClass("font-mono");
    await waitFor(() => expect(selectWorkspace).toHaveBeenCalledWith(workspaceDetail.id));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/workspaces/${workspaceDetail.id}`),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the collision-resolved final slug when the server appends a suffix", async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: { ...workspaceDetail, slug: "acme-design-2" },
        slug: "acme-design-2",
      },
    });
    render(<CreateWorkspaceDialog />);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Workspace name"), "Acme Design");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText(/final handle/i)).toBeVisible();
    expect(screen.getByText("acme-design-2")).toBeVisible();
  });

  it("disables submit while the name/slug are invalid and never calls the API", async () => {
    const user = userEvent.setup();
    render(<CreateWorkspaceDialog />);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Workspace name"), "A");
    await user.clear(within(dialog).getByLabelText("Workspace slug"));
    expect(within(dialog).getByRole("button", { name: "Create workspace" })).toBeDisabled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("shows an error state and stays open when creation is denied", async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkspace).mockResolvedValue({ ok: false, kind: "forbidden" });
    render(<CreateWorkspaceDialog />);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Workspace name"), "Acme Design");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not permitted/i);
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("reuses one idempotency key when an unchanged create request is retried", async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkspace).mockResolvedValue({ ok: false, kind: "network" });
    render(<CreateWorkspaceDialog />);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Workspace name"), "Retry Workspace");

    const submit = within(dialog).getByRole("button", { name: "Create workspace" });
    await user.click(submit);
    await screen.findByRole("alert");
    await user.click(submit);
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledTimes(2));

    const firstKey = vi.mocked(createWorkspace).mock.calls[0]?.[1];
    const secondKey = vi.mocked(createWorkspace).mock.calls[1]?.[1];
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondKey).toBe(firstKey);
  });

  it("keeps the final slug visible and retries when selecting the created workspace fails", async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: { ...workspaceDetail, slug: "acme-design-2" },
        slug: "acme-design-2",
      },
    });
    vi.mocked(selectWorkspace)
      .mockResolvedValueOnce({ ok: false, kind: "network" })
      .mockResolvedValueOnce({ ok: true, data: true });

    render(<CreateWorkspaceDialog />);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Workspace name"), "Acme Design");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /was created.*could not be made current/i,
    );
    expect(screen.getByText("acme-design-2")).toBeVisible();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();

    router.refresh.mockClear();
    await user.click(screen.getByRole("button", { name: "Retry and open workspace" }));
    await waitFor(() => expect(selectWorkspace).toHaveBeenCalledTimes(2));
    expect(router.push).toHaveBeenCalledWith(`/workspaces/${workspaceDetail.id}`);
    expect(router.refresh).toHaveBeenCalled();
  });
});
