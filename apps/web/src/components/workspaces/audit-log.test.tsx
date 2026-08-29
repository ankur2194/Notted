import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogEntry } from "@notted/shared-types";

import { AuditLog } from "@/components/workspaces/AuditLog";
import { auditLogExportUrl, listAuditLogs } from "@/lib/audit-logs/requests";

vi.mock("@/lib/audit-logs/requests", () => ({
  listAuditLogs: vi.fn(),
  auditLogExportUrl: vi.fn(() => "https://api.example.test/api/v1/workspaces/x/audit-logs/export"),
}));

const WORKSPACE_ID = "50000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000002";

const list = vi.mocked(listAuditLogs);
const exportUrl = vi.mocked(auditLogExportUrl);

const entry: AuditLogEntry = {
  id: "50000000-0000-4000-8000-000000000003",
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  userName: "Ada Lovelace",
  action: "apiKey.created",
  entityType: "apiKey",
  entityId: "50000000-0000-4000-8000-000000000004",
  metadata: { name: "CI deploy" },
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0",
  requestId: "50000000-0000-4000-8000-000000000005",
  createdAt: "2026-08-01T12:00:00.000Z",
};

function page(items: readonly AuditLogEntry[], hasMore = false) {
  return { ok: true, data: { items, page: 1, limit: 25, hasMore } } as const;
}

describe("AuditLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exportUrl.mockReturnValue("https://api.example.test/api/v1/workspaces/x/audit-logs/export");
  });

  it("says it is loading before the first page arrives", () => {
    list.mockReturnValue(new Promise<never>(() => undefined));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);

    expect(screen.getByText("Loading audit log…")).toBeVisible();
  });

  it("renders a row with its columns", async () => {
    list.mockResolvedValue(page([entry]));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("apiKey.created")).toBeVisible();
    expect(screen.getByText("apiKey")).toBeVisible();
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("203.0.113.7")).toBeVisible();
    expect(screen.getByText(new Date(entry.createdAt).toLocaleString())).toBeVisible();
  });

  it("puts the metadata, entity id, user agent, and request id inside a details disclosure", async () => {
    list.mockResolvedValue(page([entry]));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);
    await screen.findByText("apiKey.created");

    // "Details" is both the column header and the disclosure summary, so scope
    // the lookup to the data row.
    const row = screen.getByText("apiKey.created").closest("tr") as HTMLElement;
    const details = within(row).getByText("Details").closest("details");
    expect(details).not.toBeNull();
    expect(details).toHaveTextContent(entry.entityId);
    expect(details).toHaveTextContent("Mozilla/5.0");
    expect(details).toHaveTextContent(entry.requestId as string);
    expect(details).toHaveTextContent('"name":"CI deploy"');
  });

  it("names the missing permission rather than offering a pointless retry", async () => {
    list.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    render(<AuditLog workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You need to be a workspace admin to view the audit log.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("alerts and retries when the log cannot be loaded", async () => {
    list.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    list.mockResolvedValueOnce(page([entry]));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The audit log could not be loaded. Nothing was changed.");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("apiKey.created")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("shows the empty state when no events match the filters", async () => {
    list.mockResolvedValue(page([]));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("No audit events match these filters.")).toBeVisible();
  });

  it("re-requests with the parsed filter and resets to page 1", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([entry], true));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);
    await screen.findByText("apiKey.created");

    // Move to page 2 first, so the reset is observable.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2");

    await user.type(screen.getByLabelText("Action"), "apiKey.created");
    await user.type(screen.getByLabelText("Actor user id"), USER_ID);
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByText("Page 1")).toBeVisible();
    const lastCall = list.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({
      page: 1,
      limit: 25,
      action: "apiKey.created",
      userId: USER_ID,
    });
  });

  it("moves pages with Next/Prev, and disables Prev on page 1", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(page([entry], true));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);
    await screen.findByText("apiKey.created");

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Page 2")).toBeVisible();
    const lastCall = list.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ page: 2 });
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("ignores a superseded response that lands after a newer one", async () => {
    // Nothing ordered these responses. Filtering (or paging) while the previous
    // request is still in flight left the older answer free to overwrite the
    // newer one, so the table showed unfiltered rows under the applied filter.
    const user = userEvent.setup();
    const filtered: AuditLogEntry = { ...entry, id: `${USER_ID}9`, action: "webhook.created" };
    let resolveFirst: (value: ReturnType<typeof page>) => void = () => undefined;
    list.mockReturnValueOnce(
      new Promise((resolvePage) => {
        resolveFirst = resolvePage;
      }),
    );
    list.mockResolvedValue(page([filtered]));

    render(<AuditLog workspaceId={WORKSPACE_ID} />);
    await user.type(screen.getByLabelText("Action"), "webhook.created");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText("webhook.created")).toBeVisible();

    // The unfiltered first request finally answers.
    resolveFirst(page([entry]));
    await screen.findByText("webhook.created");

    expect(screen.queryByText("apiKey.created")).toBeNull();
  });

  it("disables Next when there is no further page", async () => {
    list.mockResolvedValue(page([entry], false));
    render(<AuditLog workspaceId={WORKSPACE_ID} />);
    await screen.findByText("apiKey.created");

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("exposes the export as a download anchor carrying the workspace id", async () => {
    list.mockResolvedValue(page([entry]));
    exportUrl.mockReturnValue(
      `https://api.example.test/api/v1/workspaces/${WORKSPACE_ID}/audit-logs/export`,
    );
    render(<AuditLog workspaceId={WORKSPACE_ID} />);
    await screen.findByText("apiKey.created");

    const link = screen.getByRole("link", { name: "Export CSV" });
    expect(link).toHaveAttribute("download");
    expect(link).toHaveAttribute("href", expect.stringContaining(WORKSPACE_ID));
  });
});
