import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeySummary } from "@notted/shared-types";

import { ApiKeys } from "@/components/workspaces/ApiKeys";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api-keys/requests";

vi.mock("@/lib/api-keys/requests", () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

const WORKSPACE_ID = "50000000-0000-4000-8000-000000000001";
const API_KEY_ID = "50000000-0000-4000-8000-000000000002";
const USER_ID = "50000000-0000-4000-8000-000000000003";
const SECRET = "ntd_pk_abcdefghijklmnopqrstuvwxyz012345";

const list = vi.mocked(listApiKeys);
const create = vi.mocked(createApiKey);
const revoke = vi.mocked(revokeApiKey);

const apiKey: ApiKeySummary = {
  id: API_KEY_ID,
  workspaceId: WORKSPACE_ID,
  name: "CI deploy",
  keyPrefix: "ntd_pk_a",
  scopes: ["read", "write"],
  lastUsedAt: null,
  expiresAt: null,
  isRevoked: false,
  createdById: USER_ID,
  createdAt: "2026-08-01T00:00:00.000Z",
};

function page(items: readonly ApiKeySummary[]) {
  return { ok: true, data: { items, page: 1, limit: 50, hasMore: false } } as const;
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Name"), "CI deploy");
  await user.click(screen.getByRole("button", { name: "Create API key" }));
}

describe("ApiKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says it is loading before the first page arrives", () => {
    list.mockReturnValue(new Promise<never>(() => undefined));
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);

    expect(screen.getByText("Loading API keys…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();
  });

  it("offers the create form when the workspace has no keys yet", async () => {
    list.mockResolvedValue(page([]));
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("No API keys yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create API key" })).toBeVisible();
    // Read and write are the shared default; admin is opt-in.
    expect(screen.getByRole("checkbox", { name: /^Read/u })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Write/u })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Admin/u })).not.toBeChecked();
    // Native date input, not a picker widget.
    expect(screen.getByLabelText(/Expires on/u)).toHaveAttribute("type", "date");
  });

  it("alerts and retries when the list cannot be loaded", async () => {
    list.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    list.mockResolvedValueOnce(page([apiKey]));
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/iu);
    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("CI deploy")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("names the missing permission rather than offering a pointless retry", async () => {
    list.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You need to be a workspace admin to manage API keys.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();
  });

  it("shows a created key once, then never again after it is dismissed", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([]));
    create.mockResolvedValue({ ok: true, data: { apiKey, secret: SECRET } });
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);
    await screen.findByText("No API keys yet.");

    list.mockResolvedValue(page([apiKey]));
    await fillAndSubmit(user);

    expect(await screen.findByText(SECRET)).toBeVisible();
    expect(screen.getByText(/only time this key will be shown/iu)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());

    // A refetch reads the list endpoint, which has no secret field at all.
    await user.click(screen.getByRole("button", { name: "Revoke CI deploy" }));
    revoke.mockResolvedValue({ ok: true, data: { apiKeyId: API_KEY_ID, revoked: true } });
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(revoke).toHaveBeenCalled());
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("sends a fresh idempotency key for every submission", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([]));
    create.mockResolvedValue({ ok: true, data: { apiKey, secret: SECRET } });
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);
    await screen.findByText("No API keys yet.");

    await fillAndSubmit(user);
    await screen.findByText(SECRET);
    await fillAndSubmit(user);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const [first, second] = create.mock.calls.map((call) => call[2]);
    expect(first).toEqual(expect.any(String));
    // A replayed create cannot reproduce a secret, so a second submission must
    // never reuse the first key.
    expect(first).not.toBe(second);
    expect(create.mock.calls[0]?.[1]).toEqual({
      name: "CI deploy",
      scopes: ["read", "write"],
      expiresAt: undefined,
    });
  });

  it("refuses to submit without a scope and reports it in the live region", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([]));
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);
    await screen.findByText("No API keys yet.");

    await user.click(screen.getByRole("checkbox", { name: /^Read/u }));
    await user.click(screen.getByRole("checkbox", { name: /^Write/u }));
    await fillAndSubmit(user);

    expect(await screen.findByText("Select at least one scope.")).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports a rejected create without pretending a key exists", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([]));
    create.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);
    await screen.findByText("No API keys yet.");

    await fillAndSubmit(user);

    expect(
      await screen.findByText("You need to be a workspace admin to manage API keys."),
    ).toBeVisible();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("lists a key's prefix, scopes, usage, and revoked state", async () => {
    list.mockResolvedValue(
      page([
        {
          ...apiKey,
          isRevoked: true,
          lastUsedAt: "2026-08-10T00:00:00.000Z",
          expiresAt: "2026-12-31T00:00:00.000Z",
        },
      ]),
    );
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("CI deploy")).toBeVisible();
    expect(screen.getByText("ntd_pk_a")).toBeVisible();
    expect(screen.getByText("Scopes: read, write")).toBeVisible();
    expect(screen.getByText(/Last used:/u)).toBeVisible();
    expect(screen.getByText("Revoked")).toBeVisible();
    // A revoked key has nothing left to revoke.
    expect(screen.queryByRole("button", { name: /^Revoke/u })).toBeNull();
  });

  it("puts revoke behind a confirmation that can be cancelled", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([apiKey]));
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);
    await screen.findByText("CI deploy");

    await user.click(screen.getByRole("button", { name: "Revoke CI deploy" }));
    expect(screen.getByText(/stops working immediately/iu)).toBeVisible();
    expect(revoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revoke).not.toHaveBeenCalled();
    // Cancelling unmounts the confirmation, so focus must come back to the
    // control that opened it rather than falling to the document.
    expect(screen.getByRole("button", { name: "Revoke CI deploy" })).toHaveFocus();

    revoke.mockResolvedValue({ ok: true, data: { apiKeyId: API_KEY_ID, revoked: true } });
    list.mockResolvedValue(page([{ ...apiKey, isRevoked: true }]));
    await user.click(screen.getByRole("button", { name: "Revoke CI deploy" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(revoke).toHaveBeenCalledWith(WORKSPACE_ID, API_KEY_ID);
    expect(await screen.findByText(/was revoked and can no longer be used/iu)).toBeVisible();
    expect(await screen.findByText("Revoked")).toBeVisible();
    // The revoke control is gone for good, so the section heading takes focus.
    expect(screen.getByRole("heading", { name: "API keys" })).toHaveFocus();
  });

  it("copies the created key only when asked", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([]));
    create.mockResolvedValue({ ok: true, data: { apiKey, secret: SECRET } });
    render(<ApiKeys workspaceId={WORKSPACE_ID} />);
    await screen.findByText("No API keys yet.");

    await fillAndSubmit(user);
    await screen.findByText(SECRET);

    await user.click(screen.getByRole("button", { name: "Copy key" }));

    await expect(navigator.clipboard.readText()).resolves.toBe(SECRET);
  });
});
