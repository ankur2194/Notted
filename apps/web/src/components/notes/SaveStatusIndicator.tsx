"use client";

import type { AutosaveDescription, AutosaveStatus } from "@/lib/notes/autosave-machine";

import { Button } from "@/components/ui/button";

/**
 * The save state, in plain language, with the explicit resolution affordances
 * Part 39 requires.
 *
 * Inline and polite rather than a toast: `sonner` is mounted in this
 * application but nothing calls `toast()`, and a toast for every save cycle
 * would interrupt the writer several times a minute. A single live region that
 * rewrites itself announces the change once and stays readable afterwards.
 *
 * Nothing here is conveyed by colour alone — every state has its own words —
 * and neither button is ever natively `disabled`, so a control cannot vanish
 * from the tab order while it is focused (the Part 34 rule).
 */
export interface SaveStatusIndicatorProps {
  readonly status: AutosaveStatus;
  readonly description: AutosaveDescription;
  /** The editor produced JSON the note contract rejects. */
  readonly documentRejected: boolean;
  readonly onRetry: () => void;
  /** Discards local changes and re-reads the note from the server. */
  readonly onReload: () => void;
}

const SEVERITY_CLASS: Readonly<Record<AutosaveDescription["severity"], string>> = {
  info: "text-muted-foreground",
  warning: "text-foreground",
  error: "text-destructive",
};

export function SaveStatusIndicator({
  status,
  description,
  documentRejected,
  onRetry,
  onReload,
}: SaveStatusIndicatorProps) {
  return (
    <div className="notted-save-status space-y-2" data-notted-print-hide>
      <div
        // Polite, atomic, and re-read in full: a partial announcement such as
        // "Retrying…" without its cause is worse than none.
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="note-save-status"
        data-save-status={status}
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${SEVERITY_CLASS[description.severity]}`}
      >
        <span>{description.message}</span>
        {description.canRetry ? (
          <Button type="button" size="sm" variant="link" className="h-auto p-0" onClick={onRetry}>
            Retry saving
          </Button>
        ) : null}
        {description.canReload ? (
          <Button type="button" size="sm" variant="link" className="h-auto p-0" onClick={onReload}>
            Reload latest version
          </Button>
        ) : null}
      </div>
      {documentRejected ? (
        // Assertive, and separate from the status line: the editor stopped
        // reporting changes at all, so the save state alone would look calm
        // while nothing new was being persisted.
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm"
          data-testid="note-save-rejected"
        >
          The last change produced content this note&rsquo;s format does not allow, so it was not
          saved. Nothing you type after it will be saved either until you undo it.
        </p>
      ) : null}
    </div>
  );
}
