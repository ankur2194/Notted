import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail, WorkspaceStorageUsage } from "@notted/shared-types";

import { WorkspaceSettings } from "@/components/workspaces/WorkspaceSettings";
import { loadWorkspaceDomain } from "@/lib/workspaces/domain-requests";
import {
  deleteWorkspace,
  deleteWorkspaceLogo,
  requestWorkspaceStorageUsage,
  updateWorkspace,
  uploadWorkspaceLogo,
} from "@/lib/workspaces/requests";

// Part 73 moved the custom domain into its own section with its own routes.
// Settings only has to prove the section is mounted for the right role; the
// section's own behaviour is covered by `custom-domain-settings.test.tsx`.
vi.mock("@/lib/workspaces/domain-requests", () => ({
  loadWorkspaceDomain: vi.fn(),
  setWorkspaceDomain: vi.fn(),
  verifyWorkspaceDomain: vi.fn(),
  removeWorkspaceDomain: vi.fn(),
}));

const { router } = vi.hoisted(() => ({
  router: { replace: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/workspaces/requests", async () => {
  // `WORKSPACE_LOGO_MAX_BYTES` is a constant the component reads, not a
  // request: mocking it away would make the oversize test assert against a
  // ceiling of `undefined`.
  const actual = await vi.importActual<typeof import("@/lib/workspaces/requests")>(
    "@/lib/workspaces/requests",
  );
  return {
    WORKSPACE_LOGO_MAX_BYTES: actual.WORKSPACE_LOGO_MAX_BYTES,
    updateWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    requestWorkspaceStorageUsage: vi.fn(),
    uploadWorkspaceLogo: vi.fn(),
    deleteWorkspaceLogo: vi.fn(),
  };
});

const workspace = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Acme Design",
  slug: "acme-design",
  description: "Brand workspace",
  plan: "pro",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "a4" },
  storageLimitBytes: 1_073_741_824,
  createdById: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceDetail;

/**
 * Part 45 usage fixture. Values are chosen so that none of them formats to
 * "1 GiB" or "1,073,741,824 bytes" — those strings are asserted with `getByText`
 * for the Part 26 storage-limit override, and a collision would make those
 * pre-existing assertions fail on ambiguity rather than on behaviour.
 */
const storageUsage = {
  workspaceId: workspace.id,
  plan: "pro",
  usedBytes: 536_870_912, // 512 MiB — 25% of the limit
  pendingBytes: 0,
  limitBytes: 2_147_483_648, // 2 GiB
  availableBytes: 1_610_612_736, // 1.5 GiB
  attachmentCount: 3,
  limitSource: "plan",
} satisfies WorkspaceStorageUsage;

/**
 * `WorkspaceStorageUsagePanel` reads through TanStack Query, so settings now
 * needs a client. A fresh `QueryClient` per render keeps tests independent, and
 * `retry: false` makes a rejected query reach its error state in one tick
 * instead of waiting out the provider's real retry policy.
 */
function renderSettings(props: {
  readonly workspace: WorkspaceDetail;
  readonly canManage: boolean;
  readonly canDelete: boolean;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceSettings {...props} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls but keeps implementations, including any
    // queued `mockResolvedValueOnce`. Reset the request mocks explicitly so a
    // one-shot queued in one test cannot leak into the next.
    vi.mocked(updateWorkspace).mockReset();
    vi.mocked(deleteWorkspace).mockReset();
    vi.mocked(requestWorkspaceStorageUsage).mockReset();
    vi.mocked(uploadWorkspaceLogo).mockReset();
    vi.mocked(deleteWorkspaceLogo).mockReset();
    vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({ ok: true, data: storageUsage });
    vi.mocked(loadWorkspaceDomain).mockReset();
    vi.mocked(loadWorkspaceDomain).mockResolvedValue({ ok: true, data: { domain: null } });
  });

  it("saves an identity rename and refreshes from the response", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: {
          ...workspace,
          name: "Acme Design Co",
          slug: "acme-design-co",
          updatedAt: "2026-08-01T01:00:00.000Z",
        },
      },
    });
    renderSettings({ workspace, canManage: true, canDelete: true });

    const nameField = screen.getByLabelText("Workspace name");
    await user.clear(nameField);
    await user.type(nameField, "Acme Design Co");

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).not.toBeDisabled();
    await user.click(save);

    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledTimes(1));
    // Only the changed field is sent as a minimal diff.
    expect(updateWorkspace).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ name: "Acme Design Co" }),
    );
    expect(await screen.findByText(/Saved at/i)).toBeVisible();
    expect(router.refresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
    );
  });

  it("disables save when there are no changes and keeps the original values", () => {
    renderSettings({ workspace, canManage: true, canDelete: true });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByLabelText("Slug")).toHaveValue("acme-design");
    expect(screen.getByLabelText("Default page size")).toHaveValue("a4");
    expect(screen.getByText("1 GiB")).toBeVisible();
    expect(screen.getByText("1,073,741,824 bytes")).toHaveClass("sr-only");
  });

  it("updates the real default page size with a nested settings patch", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: {
          ...workspace,
          settings: { defaultPageSize: "letter" },
          updatedAt: "2026-08-01T01:00:00.000Z",
        },
      },
    });
    renderSettings({ workspace, canManage: true, canDelete: true });

    await user.selectOptions(screen.getByLabelText("Default page size"), "letter");
    await user.click(screen.getByRole("button", { name: "Save page default" }));

    await waitFor(() =>
      // `settings` is sent whole, so the unchanged accent rides along as its
      // current value (`null` = use the platform default). Sending only the
      // changed key would read on the server as "clear the accent".
      expect(updateWorkspace).toHaveBeenCalledWith(workspace.id, {
        settings: { defaultPageSize: "letter", accentColor: null },
      }),
    );
    // Several polite live regions coexist (logo state, accent contrast), so
    // select by content rather than assuming this is the only `status`.
    const saved = await screen.findByText(/settings saved at/i);
    expect(saved).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Default page size")).toHaveValue("letter");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("hides the destructive confirmation behind an exact name match", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteWorkspace).mockResolvedValue({
      ok: true,
      data: { id: workspace.id, deleted: true },
    });
    renderSettings({ workspace, canManage: true, canDelete: true });

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    const confirmField = screen.getByLabelText(/Type the workspace name/i);
    expect(confirmField).toHaveFocus();

    // A wrong name keeps the confirm button disabled.
    await user.type(confirmField, "Wrong Name");
    expect(screen.getByRole("button", { name: "Permanently delete" })).toBeDisabled();
    expect(deleteWorkspace).not.toHaveBeenCalled();

    // The exact name unlocks confirmation.
    await user.clear(confirmField);
    await user.type(confirmField, workspace.name);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await waitFor(() =>
      expect(deleteWorkspace).toHaveBeenCalledWith(workspace.id, {
        confirm: true,
        expectedName: workspace.name,
      }),
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/workspaces"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("restores focus to the delete trigger after cancellation", async () => {
    const user = userEvent.setup();
    renderSettings({ workspace, canManage: true, canDelete: true });

    const trigger = screen.getByRole("button", { name: "Delete workspace" });
    await user.click(trigger);
    expect(screen.getByLabelText(/Type the workspace name/i)).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete workspace" })).toHaveFocus();
  });

  it("surfaces a denied delete without redirecting", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteWorkspace).mockResolvedValue({ ok: false, kind: "forbidden" });
    renderSettings({ workspace, canManage: true, canDelete: true });

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await user.type(screen.getByLabelText(/Type the workspace name/i), workspace.name);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/only the owner/i);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("disables editing and delete for a viewer and renders permission notes", () => {
    renderSettings({
      workspace: { ...workspace, currentUserRole: "viewer", storageLimitBytes: null },
      canManage: false,
      canDelete: false,
    });
    expect(screen.getByText(/owner or admin access to edit/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText(/Only the workspace owner may delete/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).not.toBeInTheDocument();
    // Billing stays clearly disabled.
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeDisabled();
    expect(screen.getByText(/Billing is not available/i)).toBeVisible();
    expect(screen.getByLabelText("Default page size")).toBeDisabled();
    expect(screen.getByLabelText("Default page size")).toHaveValue("a4");
    expect(screen.getByText(/Default page size is read-only/i)).toBeVisible();
    expect(screen.getByText("Plan-managed limit")).toBeVisible();
    // The logo controls are the file input and the removal button; both are
    // inert for a viewer.
    expect(screen.getByLabelText("Workspace logo")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove logo" })).toBeDisabled();
  });

  describe("storage usage (Part 45)", () => {
    it("renders the quota bar in proportion and exposes exact byte counts", async () => {
      renderSettings({ workspace, canManage: true, canDelete: true });

      const bar = await screen.findByRole("progressbar", { name: "Storage used" });
      // The bar is driven by the server's own numbers, never a client estimate.
      expect(bar).toHaveAttribute("aria-valuemin", "0");
      expect(bar).toHaveAttribute("aria-valuemax", String(storageUsage.limitBytes));
      expect(bar).toHaveAttribute("aria-valuenow", String(storageUsage.usedBytes));
      // `aria-valuetext` overrides the raw number so a reader hears bytes, not
      // "536870912".
      expect(bar).toHaveAttribute(
        "aria-valuetext",
        "536,870,912 bytes of 2,147,483,648 bytes used.",
      );

      // 512 MiB of 2 GiB is a quarter of the track; nothing is in flight.
      expect(screen.getByTestId("storage-used-segment")).toHaveStyle({ width: "25%" });
      expect(screen.getByTestId("storage-pending-segment")).toHaveStyle({ width: "0%" });

      // Rounded values are hidden; the precise counts stay available to AT.
      expect(screen.getAllByText("512 MiB")[0]).toHaveAttribute("aria-hidden", "true");
      expect(screen.getAllByText("536,870,912 bytes")[0]).toHaveClass("sr-only");
      expect(screen.getByText("2,147,483,648 bytes")).toHaveClass("sr-only");
      expect(screen.getByText("1,610,612,736 bytes")).toHaveClass("sr-only");
      expect(screen.getByText("(3 files)")).toBeVisible();

      // No warning wording while there is room left.
      expect(screen.queryByText(/almost full|Storage full/i)).not.toBeInTheDocument();
    });

    it("shows in-flight bytes as their own segment and row", async () => {
      vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({
        ok: true,
        data: {
          ...storageUsage,
          pendingBytes: 268_435_456, // 256 MiB — 12.5% of the limit
          availableBytes: 1_342_177_280,
        },
      });
      renderSettings({ workspace, canManage: true, canDelete: true });

      expect(await screen.findByText("Uploading now")).toBeVisible();
      expect(screen.getByTestId("storage-used-segment")).toHaveStyle({ width: "25%" });
      expect(screen.getByTestId("storage-pending-segment")).toHaveStyle({ width: "12.5%" });
      // Pending bytes are already charged, so the announced total includes them.
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        "805,306,368 bytes of 2,147,483,648 bytes used, including 268,435,456 bytes still uploading.",
      );
      expect(screen.getByText("268,435,456 bytes")).toHaveClass("sr-only");
    });

    it("renders a workspace with no attachments as zero of the limit", async () => {
      vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({
        ok: true,
        data: {
          ...storageUsage,
          usedBytes: 0,
          pendingBytes: 0,
          availableBytes: storageUsage.limitBytes,
          attachmentCount: 0,
        },
      });
      renderSettings({ workspace, canManage: true, canDelete: true });

      const bar = await screen.findByRole("progressbar");
      expect(bar).toHaveAttribute("aria-valuenow", "0");
      // An empty workspace is a real zero, not a missing or broken bar.
      expect(screen.getByTestId("storage-used-segment")).toHaveStyle({ width: "0%" });
      expect(screen.getAllByText("0 B")[0]).toBeInTheDocument();
      expect(screen.getByText("(0 files)")).toBeVisible();
      expect(screen.queryByText(/almost full|Storage full/i)).not.toBeInTheDocument();
    });

    it("conveys an exhausted quota with text, not colour alone", async () => {
      vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({
        ok: true,
        data: {
          ...storageUsage,
          usedBytes: storageUsage.limitBytes,
          availableBytes: 0,
        },
      });
      renderSettings({ workspace, canManage: true, canDelete: true });

      // The state is spelled out in words for anyone who cannot see the colour
      // change, and repeated inside the bar's own announcement.
      expect(
        await screen.findByText("Storage full. New uploads are rejected until files are removed."),
      ).toBeVisible();
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        "2,147,483,648 bytes of 2,147,483,648 bytes used. Storage full. New uploads are rejected until files are removed.",
      );
      expect(screen.getByTestId("storage-used-segment")).toHaveStyle({ width: "100%" });
    });

    it("warns before the quota is exhausted", async () => {
      vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({
        ok: true,
        data: {
          ...storageUsage,
          // 90% of 2 GiB is 1,932,735,283.2 bytes, so this is the first integer
          // that actually crosses the threshold rather than sitting just under.
          usedBytes: 1_932_735_284,
          availableBytes: 214_748_364,
        },
      });
      renderSettings({ workspace, canManage: true, canDelete: true });

      expect(await screen.findByText("Storage almost full.")).toBeVisible();
    });

    it("names the plan default as the limit in force", async () => {
      renderSettings({ workspace, canManage: true, canDelete: true });

      expect(await screen.findByText("Limit of 2 GiB from the pro plan default.")).toBeVisible();
    });

    it("names a per-workspace override as the limit in force", async () => {
      vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({
        ok: true,
        data: { ...storageUsage, limitSource: "override" },
      });
      renderSettings({ workspace, canManage: true, canDelete: true });

      expect(
        await screen.findByText(
          "Limit of 2 GiB set for this workspace, overriding the pro plan default.",
        ),
      ).toBeVisible();
    });

    it("announces a loading state before usage arrives", () => {
      // Never settles, so the pending branch stays on screen for the assertion.
      vi.mocked(requestWorkspaceStorageUsage).mockReturnValue(new Promise<never>(() => {}));
      renderSettings({ workspace, canManage: true, canDelete: true });

      expect(screen.getByText("Loading storage usage…")).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("offers a retry after a failed usage load and recovers on success", async () => {
      const user = userEvent.setup();
      vi.mocked(requestWorkspaceStorageUsage)
        .mockResolvedValueOnce({ ok: false, kind: "network" })
        .mockResolvedValueOnce({ ok: true, data: storageUsage });
      renderSettings({ workspace, canManage: true, canDelete: true });

      // A failed read must not resolve to a confident "0 bytes used" bar.
      expect(await screen.findByText(/Storage usage could not be loaded/i)).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Retry" }));

      expect(await screen.findByRole("progressbar", { name: "Storage used" })).toBeVisible();
      expect(screen.queryByText(/Storage usage could not be loaded/i)).not.toBeInTheDocument();
    });

    it("renders a permission notice rather than an error when usage is denied", async () => {
      vi.mocked(requestWorkspaceStorageUsage).mockResolvedValue({ ok: false, kind: "forbidden" });
      renderSettings({
        workspace: { ...workspace, currentUserRole: "viewer" },
        canManage: false,
        canDelete: false,
      });

      expect(await screen.findByText(/not available for your access/i)).toBeVisible();
      // Retrying cannot grant access, so no retry affordance is offered.
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("shows usage to a viewer, who can read it but not change the limit", async () => {
      renderSettings({
        workspace: { ...workspace, currentUserRole: "viewer" },
        canManage: false,
        canDelete: false,
      });

      // `settings.read` is enough to see usage, so a viewer gets the real bar.
      expect(await screen.findByRole("progressbar", { name: "Storage used" })).toBeVisible();
      expect(screen.getByText(/The limit is read-only here/i)).toBeVisible();
    });
  });

  // --------------------------------------------------------------------- //
  // Part 72 — branding.
  // --------------------------------------------------------------------- //

  describe("logo", () => {
    it("uploads the chosen file as multipart and adopts the persisted path", async () => {
      const user = userEvent.setup();
      const logoUrl = `/api/v1/workspaces/${workspace.id}/logo/${"a".repeat(32)}`;
      vi.mocked(uploadWorkspaceLogo).mockResolvedValue({ ok: true, data: { logoUrl } });
      renderSettings({ workspace, canManage: true, canDelete: true });

      const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
      await user.upload(screen.getByLabelText("Workspace logo"), file);

      await waitFor(() => expect(uploadWorkspaceLogo).toHaveBeenCalledWith(workspace.id, file));
      // The persisted path is adopted; no blob/preview URL is ever stored.
      expect(await screen.findByText("A logo is set.")).toBeVisible();
      expect(router.refresh).toHaveBeenCalled();
    });

    it("rejects an oversize file in the browser without calling the API", async () => {
      const user = userEvent.setup();
      renderSettings({ workspace, canManage: true, canDelete: true });

      const oversize = new File([new Uint8Array(3 * 1_024 * 1_024)], "huge.png", {
        type: "image/png",
      });
      await user.upload(screen.getByLabelText("Workspace logo"), oversize);

      expect(await screen.findByText(/larger than 2 MB/i)).toBeVisible();
      expect(uploadWorkspaceLogo).not.toHaveBeenCalled();
    });

    it("offers Remove logo only once a logo exists", async () => {
      const user = userEvent.setup();
      vi.mocked(deleteWorkspaceLogo).mockResolvedValue({ ok: true, data: { logoUrl: null } });
      const { unmount } = renderSettings({ workspace, canManage: true, canDelete: true });
      expect(screen.getByRole("button", { name: "Remove logo" })).toBeDisabled();
      unmount();

      const branded = {
        ...workspace,
        logoUrl: `/api/v1/workspaces/${workspace.id}/logo/${"b".repeat(32)}`,
      } satisfies WorkspaceDetail;
      renderSettings({ workspace: branded, canManage: true, canDelete: true });

      const remove = screen.getByRole("button", { name: "Remove logo" });
      expect(remove).not.toBeDisabled();
      await user.click(remove);
      await waitFor(() => expect(deleteWorkspaceLogo).toHaveBeenCalledWith(workspace.id));
      expect(await screen.findByText("No logo is set.")).toBeVisible();
    });

    it("disables the file input for a role that cannot manage settings", () => {
      renderSettings({
        workspace: { ...workspace, currentUserRole: "viewer" },
        canManage: false,
        canDelete: false,
      });
      expect(screen.getByLabelText("Workspace logo")).toBeDisabled();
    });
  });

  describe("accent color", () => {
    it("reports the measured contrast for a passing accent", async () => {
      const user = userEvent.setup();
      renderSettings({ workspace, canManage: true, canDelete: true });

      const hex = screen.getByLabelText("Hex value");
      await user.clear(hex);
      await user.type(hex, "#2563eb");

      // 5.17:1 is the value the SERVER computes with the same shared function.
      expect(await screen.findByText(/5\.17:1 against white/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Save accent color" })).not.toBeDisabled();
    });

    it("blocks the save and names the remedy when contrast fails", async () => {
      const user = userEvent.setup();
      renderSettings({ workspace, canManage: true, canDelete: true });

      const hex = screen.getByLabelText("Hex value");
      await user.clear(hex);
      await user.type(hex, "#fbbf24");

      expect(await screen.findByText(/too low to save/i)).toBeVisible();
      expect(screen.getByRole("button", { name: "Save accent color" })).toBeDisabled();
      expect(updateWorkspace).not.toHaveBeenCalled();
    });

    it("warns without blocking between 3:1 and 4.5:1", async () => {
      const user = userEvent.setup();
      renderSettings({ workspace, canManage: true, canDelete: true });

      const hex = screen.getByLabelText("Hex value");
      await user.clear(hex);
      await user.type(hex, "#ef4444");

      expect(await screen.findByText(/below the 4\.5:1 needed for body text/i)).toBeVisible();
      expect(screen.getByRole("button", { name: "Save accent color" })).not.toBeDisabled();
    });

    it("sends accentColor: null when the accent is reset to the default", async () => {
      const user = userEvent.setup();
      const branded = {
        ...workspace,
        settings: { defaultPageSize: "a4", accentColor: "#0f766e" },
      } satisfies WorkspaceDetail;
      vi.mocked(updateWorkspace).mockResolvedValue({
        ok: true,
        data: { workspace: { ...branded, settings: { defaultPageSize: "a4" } } },
      });
      renderSettings({ workspace: branded, canManage: true, canDelete: true });

      await user.click(screen.getByRole("button", { name: "Use default" }));
      await user.click(screen.getByRole("button", { name: "Save accent color" }));

      await waitFor(() =>
        expect(updateWorkspace).toHaveBeenCalledWith(workspace.id, {
          settings: { defaultPageSize: "a4", accentColor: null },
        }),
      );
    });

    it("is read-only for a role that cannot manage settings", () => {
      renderSettings({
        workspace: { ...workspace, currentUserRole: "viewer" },
        canManage: false,
        canDelete: false,
      });
      expect(screen.getByLabelText("Hex value")).toBeDisabled();
      expect(screen.getByLabelText("Accent color")).toBeDisabled();
      expect(screen.getByText(/accent color is read-only for your role/i)).toBeVisible();
    });
  });

  describe("custom domain", () => {
    it("no longer offers a writable domain field in Identity", () => {
      renderSettings({ workspace, canManage: true, canDelete: true });

      // Part 73: the hostname is claimed and verified through its own section,
      // so a field that could save an unverified value must not exist.
      expect(screen.queryByLabelText("Custom domain (optional)")).toBeNull();
      expect(document.getElementById("settings-domain")).toBeNull();
    });

    it("renders the custom-domain section for an admin", async () => {
      renderSettings({ workspace, canManage: true, canDelete: true });

      expect(await screen.findByRole("heading", { name: "Custom domain", level: 2 })).toBeVisible();
      expect(loadWorkspaceDomain).toHaveBeenCalledWith(workspace.id);
    });

    it("hides it from a role that cannot change settings", () => {
      renderSettings({
        workspace: { ...workspace, currentUserRole: "viewer" },
        canManage: false,
        canDelete: false,
      });

      expect(screen.queryByRole("heading", { name: "Custom domain" })).toBeNull();
      expect(loadWorkspaceDomain).not.toHaveBeenCalled();
    });
  });
});
