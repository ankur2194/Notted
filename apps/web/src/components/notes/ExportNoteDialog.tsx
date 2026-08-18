"use client";

import { SUPPORTED_EXPORT_FORMATS } from "@notted/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useRef, useState } from "react";

import type { ApiRequestFailure } from "@/lib/api/request-json";
import type { ExportFormat } from "@notted/shared-types";
import type { ExportCreateInput } from "@notted/shared-validators";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useExportJob } from "@/hooks/useExportJob";
import { cancelExportJob, createExportJob, exportDownloadUrl } from "@/lib/api/export-requests";
import { exportQueryKeys } from "@/lib/exports/query-keys";

/*
 * Part 64 — the user-facing half of the export lifecycle.
 *
 * A discrete Button opening a Dialog, not a dropdown menu: exporting takes
 * choices (format, and for `zip` what goes in it) and then keeps running, and a
 * menu that closes on selection has nowhere to report progress or a failure.
 * The shape follows `ShareModal` deliberately, down to the trailing
 * `aria-live` paragraph, so the two note-header dialogs behave identically for
 * a screen reader.
 */

const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = Object.freeze({
  txt: "Plain text (.txt)",
  html: "Web page (.html)",
  pdf: "PDF (.pdf)",
  markdown: "Markdown (.md)",
  docx: "Word document (.docx)",
  zip: "Archive with extras (.zip)",
});

/**
 * The closed set of terminal failure reasons the API ships
 * (`ExportFailureCode`). There is no separate code for "this deployment has no
 * PDF renderer": a missing `EXPORT_CHROMIUM_PATH` surfaces as
 * `generation_failed`, so that copy is widened below — and only when the user
 * actually asked for a PDF, because suggesting it for a `.txt` failure would be
 * a lie.
 */
const FAILURE_COPY: Readonly<Record<string, string>> = Object.freeze({
  source_unavailable:
    "The note could not be read while the file was being produced. It may have been moved or deleted. Reload the note, then export it again.",
  source_forbidden:
    "Your permission to export this note changed while the file was being produced, so nothing was written.",
  format_unsupported:
    "This deployment cannot produce that format. Choose another format and export again.",
  generation_failed: "The file could not be produced from this note.",
  storage_unavailable:
    "The file was produced but could not be stored, so there is nothing to download. Try again in a few minutes.",
});

function failureCopy(errorCode: string | null, format: ExportFormat): string {
  const base =
    errorCode === null
      ? "The export failed for an unrecorded reason."
      : (FAILURE_COPY[errorCode] ??
        "The export failed for a reason this version of Notted does not recognise.");
  return errorCode === "generation_failed" && format === "pdf"
    ? `${base} PDF rendering may be unavailable on this deployment — try Web page or Markdown instead.`
    : base;
}

function requestFailureCopy(failure: ApiRequestFailure): string {
  if (failure.kind === "forbidden-or-not-found") {
    return "Exporting was denied. Your access to this note or workspace may have changed.";
  }
  if (failure.kind === "unavailable") {
    const seconds =
      failure.retryAfterMs === undefined ? null : Math.ceil(failure.retryAfterMs / 1_000);
    return seconds === null
      ? "The export service is unreachable. Check your connection, then retry."
      : `The export service is busy or unreachable. Retry in about ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  if (failure.kind === "invalid") {
    return "The export request was not accepted. Choose a different format, then retry.";
  }
  return "This request conflicts with a recent change to the export. Retry.";
}

export function ExportNoteDialog({
  workspaceId,
  noteId,
  canExport,
}: {
  readonly workspaceId: string;
  readonly noteId: string;
  /** Straight from `note.capabilities.canExport`; the backend policy is authoritative. */
  readonly canExport: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Driven off the shared constant so the picker can never offer a format the
  // generator has not shipped, and never miss one it has.
  const [format, setFormat] = useState<ExportFormat>(SUPPORTED_EXPORT_FORMATS[0] ?? "txt");
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [includeComments, setIncludeComments] = useState(false);
  const [includeVersionHistory, setIncludeVersionHistory] = useState(false);
  const [exportId, setExportId] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<ApiRequestFailure | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [status, setStatus] = useState("");
  // One idempotency key per user-initiated export, reused across every retry of
  // that same request so a retry after a timeout cannot queue a second render.
  const pending = useRef<{ readonly fingerprint: string; readonly key: string } | null>(null);

  const poll = useExportJob({ workspaceId, exportId, enabled: open && exportId !== null });
  const job = poll.job;
  // The three include toggles only mean anything inside an archive; every other
  // format is a single rendered document with nowhere to put them.
  const bundles = format === "zip";

  async function start(): Promise<void> {
    const input: ExportCreateInput = {
      format,
      sourceType: "note",
      sourceId: noteId,
      options: {
        includeAttachments: bundles && includeAttachments,
        includeComments: bundles && includeComments,
        includeVersionHistory: bundles && includeVersionHistory,
      },
    };
    const fingerprint = JSON.stringify(input);
    if (pending.current?.fingerprint !== fingerprint) {
      pending.current = { fingerprint, key: globalThis.crypto.randomUUID() };
    }
    setStarting(true);
    setStartFailure(null);
    setExportId(null);
    // Deliberately silent: the `role="status"` progress box, the `role="alert"`
    // failure box and the `role="status"` queued box below each already
    // announce this leg. See LIVE-REGION OWNERSHIP at the trailing paragraph.
    setStatus("");
    const result = await createExportJob(workspaceId, input, pending.current.key);
    setStarting(false);
    if (!result.ok) {
      setStartFailure(result);
      return;
    }
    pending.current = null;
    setExportId(result.data.id);
  }

  async function cancel(): Promise<void> {
    if (exportId === null) return;
    setCancelling(true);
    setStatus("Cancelling the export…");
    const result = await cancelExportJob(workspaceId, exportId);
    setCancelling(false);
    if (!result.ok) {
      setStatus("The export could not be cancelled. It may already have finished.");
      return;
    }
    queryClient.setQueryData(exportQueryKeys.detail(workspaceId, exportId), result);
    // The `role="status"` cancelled box owns the outcome sentence.
    setStatus("");
  }

  if (!canExport) return null;

  const running = job !== null && (job.status === "queued" || job.status === "processing");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Download aria-hidden="true" className="size-4" />
          Export
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Export note</DialogTitle>
          <DialogDescription>
            The file is produced on the server and downloaded through an authorized link. Exporting
            never bypasses workspace, project, or note permissions.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <label className="font-medium" htmlFor="export-format">
            Format
          </label>
          <select
            id="export-format"
            value={format}
            disabled={starting || running}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
            className="min-h-11 rounded-md border bg-background px-3"
          >
            {SUPPORTED_EXPORT_FORMATS.map((value) => (
              <option key={value} value={value}>
                {FORMAT_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        {bundles ? (
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Include in the archive</legend>
            {(
              [
                [
                  "export-include-attachments",
                  "Attachments",
                  includeAttachments,
                  setIncludeAttachments,
                ],
                ["export-include-comments", "Comments", includeComments, setIncludeComments],
                [
                  "export-include-versions",
                  "Version history",
                  includeVersionHistory,
                  setIncludeVersionHistory,
                ],
              ] as const
            ).map(([id, label, checked, set]) => (
              <div key={id} className="flex min-h-11 items-center gap-3">
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={starting || running}
                  onChange={(event) => set(event.target.checked)}
                  className="size-4"
                />
                <label htmlFor={id} className="text-sm">
                  {label}
                </label>
              </div>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm text-muted-foreground">
            Attachments, comments, and version history can only be bundled into an archive. Choose
            the .zip format to include them; every other format exports the note content alone.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={starting || running} onClick={() => void start()}>
            {starting ? "Starting…" : "Export note"}
          </Button>
          {running ? (
            <Button
              type="button"
              variant="outline"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? "Cancelling…" : "Cancel export"}
            </Button>
          ) : null}
        </div>
        {starting || (running && !poll.timedOut) ? (
          <p role="status" className="rounded-md bg-muted p-3 text-sm">
            {starting
              ? "Requesting the export…"
              : job?.status === "queued"
                ? "Queued. Waiting for a worker to pick this export up."
                : "Producing the file. This dialog updates on its own."}
          </p>
        ) : null}
        {startFailure === null ? null : (
          <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>{requestFailureCopy(startFailure)}</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void start()}>
              Retry export
            </Button>
          </div>
        )}
        {poll.errorKind === null ? null : (
          <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>
              {requestFailureCopy({
                ok: false,
                kind: poll.errorKind,
                retryAfterMs: poll.retryAfterMs,
              })}
            </p>
            <Button className="mt-2" size="sm" variant="outline" onClick={poll.retry}>
              Retry check
            </Button>
          </div>
        )}
        {poll.timedOut ? (
          <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>
              This export is still unfinished after five minutes, so Notted stopped checking on it.
              It may still complete. Check again, or start a new export.
            </p>
            <Button className="mt-2" size="sm" variant="outline" onClick={poll.retry}>
              Check again
            </Button>
          </div>
        ) : null}
        {job?.status === "ready" ? (
          <div role="status" className="rounded-md border p-3 text-sm">
            <p className="mb-2">The file is ready. The link below requires your Notted session.</p>
            {/*
             * A real anchor, not a fetch-and-blob: the route streams the bytes
             * with `Content-Disposition: attachment` and re-authorizes the
             * session cookie on every one, exactly like an attachment download.
             * The filename comes from that header, so no `download="…"` value
             * is set here — supplying one would override the server's name.
             */}
            <a
              download
              href={exportDownloadUrl(workspaceId, job.id)}
              data-testid="export-download"
              className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 font-medium underline"
            >
              <Download aria-hidden="true" className="size-4" />
              Download export
            </a>
          </div>
        ) : null}
        {job?.status === "failed" ? (
          <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>{failureCopy(job.errorCode, job.format)}</p>
            {/* Server text is already redacted to a closed, safe set, so it is shown verbatim. */}
            {job.errorMessage === null ? null : (
              <p className="mt-1 text-muted-foreground">{job.errorMessage}</p>
            )}
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void start()}>
              Retry export
            </Button>
          </div>
        ) : null}
        {job?.status === "expired" ? (
          <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>This export has expired and its file was removed. Export the note again.</p>
          </div>
        ) : null}
        {job?.status === "cancelled" ? (
          <p role="status" className="rounded-md bg-muted p-3 text-sm">
            This export was cancelled. No file was produced.
          </p>
        ) : null}
        {/*
         * No spinner anywhere in this dialog. Progress is reported as text that
         * a screen reader already announces, which sidesteps the
         * `prefers-reduced-motion` question entirely rather than answering it.
         *
         * LIVE-REGION OWNERSHIP — ONE region per message, never two. Every box
         * above is itself a live region (`role="alert"` is assertive,
         * `role="status"` is polite), so any sentence that also lands in
         * `status` here is announced TWICE. That is what used to happen to every
         * export error: identical copy in the `role="alert"` box and in this
         * paragraph.
         *
         * The rule: a box owns its own message; this paragraph carries only the
         * transient states that have NO box — today just the cancel leg. Do not
         * mirror box copy into `setStatus`.
         */}
        <p aria-live="polite" aria-atomic="true" className="min-h-6 text-sm text-muted-foreground">
          {status}
        </p>
      </DialogContent>
    </Dialog>
  );
}
