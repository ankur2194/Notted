import { EXPORT_API_PATHS } from "@notted/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createExportJob: vi.fn(),
  cancelExportJob: vi.fn(),
  exportDownloadUrl: vi.fn(),
  useExportJob: vi.fn(),
}));
vi.mock("@/lib/api/export-requests", () => ({
  createExportJob: mocks.createExportJob,
  cancelExportJob: mocks.cancelExportJob,
  exportDownloadUrl: mocks.exportDownloadUrl,
}));
vi.mock("@/hooks/useExportJob", () => ({ useExportJob: mocks.useExportJob }));

import { ExportNoteDialog } from "./ExportNoteDialog";

import type { ExportJobPoll } from "@/hooks/useExportJob";
import type { ExportJob } from "@notted/shared-types";

const workspaceId = "60000000-0000-4000-8000-000000000001";
const noteId = "60000000-0000-4000-8000-000000000002";
const exportId = "60000000-0000-4000-8000-000000000003";

function job(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    id: exportId,
    workspaceId,
    requestedById: "60000000-0000-4000-8000-000000000004",
    format: "pdf",
    status: "processing",
    sourceType: "note",
    sourceId: noteId,
    options: {
      includeAttachments: false,
      includeComments: false,
      includeVersionHistory: false,
      headerText: null,
      footerText: null,
      margins: null,
    },
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    completedAt: null,
    downloadExpiresAt: null,
    downloadPath: null,
    ...overrides,
  };
}

function poll(overrides: Partial<ExportJobPoll> = {}): ExportJobPoll {
  const base: ExportJobPoll = {
    job: null,
    status: null,
    isPolling: false,
    timedOut: false,
    errorKind: null,
    retryAfterMs: undefined,
    retry: vi.fn(),
  };
  const merged = { ...base, ...overrides };
  return { ...merged, status: merged.status ?? merged.job?.status ?? null };
}

function view(canExport = true) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ExportNoteDialog workspaceId={workspaceId} noteId={noteId} canExport={canExport} />
    </QueryClientProvider>,
  );
}

async function open() {
  const user = userEvent.setup();
  view();
  await user.click(screen.getByRole("button", { name: "Export" }));
  return user;
}

describe("ExportNoteDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useExportJob.mockReturnValue(poll());
    mocks.exportDownloadUrl.mockImplementation(
      (ws: string, id: string) =>
        `https://api.local.notted.invalid${EXPORT_API_PATHS.download(ws, id)}`,
    );
  });

  it("offers no export at all when the note capability denies it", () => {
    view(false);
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
  });

  it("opens a dialog with a labelled format picker", async () => {
    await open();
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("Format")).toBeVisible();
  });

  it("shows the include toggles only for the archive format", async () => {
    const user = await open();
    expect(screen.queryByLabelText("Attachments")).not.toBeInTheDocument();
    expect(screen.getByText(/can only be bundled into an archive/u)).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Format"), "zip");
    expect(screen.getByLabelText("Attachments")).toBeVisible();
    expect(screen.getByLabelText("Comments")).toBeVisible();
    expect(screen.getByLabelText("Version history")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Format"), "txt");
    expect(screen.queryByLabelText("Version history")).not.toBeInTheDocument();
  });

  it("sends an Idempotency-Key on create and reuses it for a retry of the same request", async () => {
    mocks.createExportJob.mockResolvedValue({ ok: false, kind: "unavailable", retryable: true });
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Export note" }));
    await user.click(await screen.findByRole("button", { name: "Retry export" }));
    expect(mocks.createExportJob).toHaveBeenCalledTimes(2);
    const firstKey: unknown = mocks.createExportJob.mock.calls[0]?.[2];
    expect(typeof firstKey).toBe("string");
    expect(String(firstKey).length).toBeGreaterThanOrEqual(8);
    expect(mocks.createExportJob.mock.calls[1]?.[2]).toBe(firstKey);
  });

  it("reports a denied export once, in an assertive region of its own", async () => {
    mocks.createExportJob.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Export note" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Exporting was denied/u)).toBeVisible();
    // Announced ONCE. The copy previously rendered in this `role="alert"` box
    // AND in the trailing `aria-live="polite"` paragraph, so a screen reader
    // read every export error twice.
    expect(screen.getAllByText(/Exporting was denied/u)).toHaveLength(1);
  });

  it("reports an unavailable poll and repeats the server's advised wait", async () => {
    mocks.useExportJob.mockReturnValue(
      poll({ job: job(), errorKind: "unavailable", retryAfterMs: 30_000 }),
    );
    await open();
    expect(await screen.findByText(/Retry in about 30 seconds/u)).toBeVisible();
  });

  it("reports the hard stop separately from a failure", async () => {
    mocks.useExportJob.mockReturnValue(poll({ job: job(), timedOut: true }));
    await open();
    expect(await screen.findByText(/stopped checking on it/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
  });

  it.each([
    ["source_unavailable", /could not be read while the file was being produced/u],
    ["source_forbidden", /permission to export this note changed/u],
    ["format_unsupported", /cannot produce that format/u],
    ["generation_failed", /could not be produced from this note/u],
    ["storage_unavailable", /could not be stored/u],
  ])("maps the %s failure code to its own copy", async (errorCode, expected) => {
    mocks.useExportJob.mockReturnValue(
      poll({
        job: job({
          status: "failed",
          format: "txt",
          errorCode,
          errorMessage: "The export could not be completed.",
        }),
      }),
    );
    await open();
    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.getByText("The export could not be completed.")).toBeVisible();
  });

  it("widens the generation failure only when the requested format was pdf", async () => {
    mocks.useExportJob.mockReturnValue(
      poll({ job: job({ status: "failed", format: "pdf", errorCode: "generation_failed" }) }),
    );
    await open();
    expect(
      await screen.findByText(/PDF rendering may be unavailable on this deployment/u),
    ).toBeVisible();
  });

  it("re-issues the create request from the failure retry affordance", async () => {
    mocks.createExportJob.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    mocks.createExportJob.mockResolvedValueOnce({ ok: true, data: job({ status: "queued" }) });
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Export note" }));
    await user.click(await screen.findByRole("button", { name: "Retry export" }));
    expect(mocks.createExportJob).toHaveBeenCalledTimes(2);
    expect(mocks.createExportJob.mock.calls[1]?.[1]).toMatchObject({
      format: "txt",
      sourceType: "note",
      sourceId: noteId,
    });
  });

  it("offers a real download anchor only once the job is ready", async () => {
    mocks.useExportJob.mockReturnValue(poll({ job: job({ status: "processing" }) }));
    const { unmount } = view();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.queryByTestId("export-download")).not.toBeInTheDocument();
    unmount();

    mocks.useExportJob.mockReturnValue(poll({ job: job({ status: "ready" }) }));
    await open();
    const anchor = await screen.findByTestId("export-download");
    expect(anchor).toBeInstanceOf(HTMLAnchorElement);
    expect(anchor).toHaveAttribute("download");
    expect(anchor.getAttribute("href")).toContain(EXPORT_API_PATHS.download(workspaceId, exportId));
  });

  it.each(["cancelled", "expired"] as const)("reports the %s terminal state", async (status) => {
    mocks.useExportJob.mockReturnValue(poll({ job: job({ status }) }));
    await open();
    expect(
      await screen.findByText(status === "cancelled" ? /was cancelled/u : /has expired/u),
    ).toBeVisible();
  });

  it("cancels the export the user actually started", async () => {
    mocks.createExportJob.mockResolvedValue({ ok: true, data: job({ status: "queued" }) });
    mocks.cancelExportJob.mockResolvedValue({ ok: true, data: job({ status: "cancelled" }) });
    // The poll answers the way production does: NO job until an export id
    // exists. A flat `mockReturnValue` of a queued job reported a running export
    // before one was started, which both disabled "Export note" and made
    // `cancel()` early-return on its null `exportId` — so the old test asserted
    // the early return, not the cancel.
    mocks.useExportJob.mockImplementation(({ exportId: id }: { exportId: string | null }) =>
      poll({ job: id === null ? null : job({ status: "queued" }) }),
    );
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Export note" }));
    await user.click(await screen.findByRole("button", { name: "Cancel export" }));
    expect(mocks.cancelExportJob).toHaveBeenCalledWith(workspaceId, exportId);
  });
});
