import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDomain, WorkspaceDomainError } from "@notted/shared-types";

import { CustomDomainSettings } from "@/components/workspaces/CustomDomainSettings";
import {
  loadWorkspaceDomain,
  removeWorkspaceDomain,
  setWorkspaceDomain,
  verifyWorkspaceDomain,
} from "@/lib/workspaces/domain-requests";

vi.mock("@/lib/workspaces/domain-requests", () => ({
  loadWorkspaceDomain: vi.fn(),
  setWorkspaceDomain: vi.fn(),
  verifyWorkspaceDomain: vi.fn(),
  removeWorkspaceDomain: vi.fn(),
}));

const WORKSPACE_ID = "50000000-0000-4000-8000-000000000001";

const load = vi.mocked(loadWorkspaceDomain);
const claim = vi.mocked(setWorkspaceDomain);
const verify = vi.mocked(verifyWorkspaceDomain);
const remove = vi.mocked(removeWorkspaceDomain);

const domain: WorkspaceDomain = {
  id: "50000000-0000-4000-8000-000000000002",
  workspaceId: WORKSPACE_ID,
  hostname: "notes.example.com",
  status: "pending",
  lastError: null,
  lastCheckedAt: null,
  verifiedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  verificationRecord: {
    name: "_notted-verify.notes.example.com",
    type: "TXT",
    value: "notted-verify=abc123",
  },
  cnameRecord: { name: "notes.example.com", type: "CNAME", value: "edge.notted.example" },
};

function result(value: WorkspaceDomain | null) {
  return { ok: true, data: { domain: value } } as const;
}

describe("CustomDomainSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers a labelled form when no domain is claimed", async () => {
    load.mockResolvedValue(result(null));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    const input = await screen.findByRole("textbox", { name: "Domain name" });
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("placeholder", "notes.example.com");
    expect(input).toHaveAttribute("maxlength", "253");
    expect(screen.getByRole("button", { name: "Add domain" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Custom domain", level: 2 })).toBeVisible();
    // The primary-host sign-in limitation must be stated wherever the feature is.
    expect(screen.getByText(/always happens on the primary application host/iu)).toBeVisible();
  });

  it("says it is loading before the first read lands", () => {
    load.mockReturnValue(new Promise<never>(() => undefined));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    expect(screen.getByText("Loading the custom domain…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
  });

  it("refuses an unusable hostname locally, without a round trip", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(result(null));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    await user.type(
      await screen.findByRole("textbox", { name: "Domain name" }),
      "http://notes.example.com/x",
    );
    await user.click(screen.getByRole("button", { name: "Add domain" }));

    expect(await screen.findByText(/Enter a public domain name/iu)).toBeVisible();
    expect(claim).not.toHaveBeenCalled();
  });

  it("claims a hostname and shows both DNS records with copy controls", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(result(null));
    claim.mockResolvedValue(result(domain));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    await user.type(
      await screen.findByRole("textbox", { name: "Domain name" }),
      "notes.example.com",
    );
    await user.click(screen.getByRole("button", { name: "Add domain" }));

    expect(claim).toHaveBeenCalledWith(WORKSPACE_ID, "notes.example.com");
    expect(await screen.findByText("notted-verify=abc123")).toBeVisible();
    expect(screen.getByText("edge.notted.example")).toBeVisible();
    expect(screen.getByText("TXT record — _notted-verify.notes.example.com")).toBeVisible();
    // Status is spelled out, not carried by colour.
    expect(screen.getByText("Pending verification")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Copy TXT record value" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("notted-verify=abc123");

    await user.click(screen.getByRole("button", { name: "Copy CNAME record value" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("edge.notted.example");
  });

  it.each<[WorkspaceDomainError, RegExp]>([
    ["txt_missing", /TXT record was not found/iu],
    ["txt_mismatch", /value does not match/iu],
    ["cname_mismatch", /does not point at Notted/iu],
    ["dns_failure", /nameservers could not be reached/iu],
  ])("explains the %s failure in plain English", async (lastError, message) => {
    load.mockResolvedValue(result({ ...domain, status: "error", lastError }));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByText("Verification failed")).toBeVisible();
  });

  it("re-checks and reports a verified domain", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(result(domain));
    verify.mockResolvedValue(
      result({ ...domain, status: "verified", verifiedAt: "2026-08-02T00:00:00.000Z" }),
    );
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    await user.click(await screen.findByRole("button", { name: "Check again" }));

    expect(verify).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(await screen.findByText("Verified")).toBeVisible();
    expect(screen.getByText(/is verified and active/iu)).toBeVisible();
  });

  it("removes the domain and returns to the empty form", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(result(domain));
    remove.mockResolvedValue(result(null));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    await user.click(await screen.findByRole("button", { name: "Remove domain" }));

    expect(remove).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(await screen.findByRole("textbox", { name: "Domain name" })).toBeVisible();
    expect(screen.getByText(/served on the primary host only/iu)).toBeVisible();
  });

  it("disables every control while a check is in flight", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(result(domain));
    verify.mockReturnValue(new Promise<never>(() => undefined));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    await user.click(await screen.findByRole("button", { name: "Check again" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Remove domain" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy TXT record value" })).toBeDisabled();
  });

  it("names a specific remedy when the hostname is already claimed", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(result(null));
    claim.mockResolvedValue({ ok: false, kind: "conflict", code: "DOMAIN_TAKEN" });
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    await user.type(
      await screen.findByRole("textbox", { name: "Domain name" }),
      "notes.example.com",
    );
    await user.click(screen.getByRole("button", { name: "Add domain" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already claimed by another workspace/iu,
    );
  });

  it("states the feature may be unavailable rather than offering a pointless retry", async () => {
    load.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("note")).toHaveTextContent(
      /not enabled on this deployment, or you do not have access/iu,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Domain name" })).toBeNull();
  });

  it("retries a transient load failure", async () => {
    load.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    load.mockResolvedValueOnce(result(domain));
    render(<CustomDomainSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/iu);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("notes.example.com")).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
