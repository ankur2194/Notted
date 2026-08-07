import { TriangleAlert } from "lucide-react";

import type { WorkspaceStorageUsage as WorkspaceStorageUsageValue } from "@notted/shared-types";

import { exactByteLabel, formatBinaryBytes } from "@/lib/notes/format-bytes";
import { cn } from "@/lib/utils";
import { storageSeverityMessage, summarizeStorageUsage } from "@/lib/workspaces/storage-usage";

/**
 * The Part 45 workspace usage display: one quota bar plus the numbers behind it.
 *
 * Purely presentational and free of client state, so the server-rendered
 * workspace overview and the client settings island render the identical thing
 * from the identical contract. Fetching, retrying, and permission handling are
 * the caller's job (`WorkspaceStorageUsagePanel`).
 *
 * ## Why `role="progressbar"` and not `role="meter"`
 *
 * `meter` is the semantically purer fit — this is a gauge, not a task in
 * progress — but its screen-reader support is still uneven, and where it is
 * unmapped the element degrades to an unlabelled group and the reader hears
 * nothing at all. `progressbar` is mapped everywhere, and the thing that
 * actually carries the meaning here is `aria-valuetext`, which both roles
 * support. A silently-unread quota is a worse failure than a slightly loose
 * role, so this takes the well-supported one.
 *
 * `aria-valuetext` also does the real work of overriding the numeric
 * announcement: without it a reader says "1073741824", which is not a number a
 * human parses. The bar therefore announces a full sentence in exact bytes, and
 * the legend below repeats each figure with the established a11y split —
 * rounded value `aria-hidden`, exact count in a visually hidden span.
 *
 * ## Why pending bytes get their own segment
 *
 * `pendingBytes` are already charged against the quota by the API. Folding them
 * into the used segment would misattribute bytes the user cannot yet open;
 * hiding them would make the remaining figure look wrong mid-upload. They get a
 * distinct, hatched segment and their own legend row.
 *
 * ## Non-colour state (WCAG 2.2 AA, 1.4.1)
 *
 * Full and nearly-full are announced by an icon plus a sentence, and folded into
 * `aria-valuetext`. The colour change is redundant reinforcement, never the
 * signal.
 */

/**
 * Diagonal hatch for the in-flight segment. A texture rather than only a tint,
 * so the two segments stay distinguishable without relying on colour.
 */
const PENDING_HATCH =
  "repeating-linear-gradient(45deg, transparent 0 3px, rgb(255 255 255 / 0.55) 3px 6px)";

function UsageFigure({ bytes }: { readonly bytes: number }) {
  return (
    <>
      <span aria-hidden="true">{formatBinaryBytes(bytes)}</span>
      <span className="sr-only">{exactByteLabel(bytes)}</span>
    </>
  );
}

export function WorkspaceStorageUsage({
  usage,
  className,
}: {
  readonly usage: WorkspaceStorageUsageValue;
  readonly className?: string;
}) {
  // Derived from the workspace id rather than `useId`, because this component is
  // rendered directly by the Server Component overview page and hooks are not
  // available there. One usage bar per workspace, so the id stays unique.
  const labelId = `storage-usage-label-${usage.workspaceId}`;
  const summary = summarizeStorageUsage(usage);
  const severityMessage = storageSeverityMessage(summary.severity);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span id={labelId} className="text-sm font-medium">
          Storage used
        </span>
        <span className="text-sm text-muted-foreground">
          <UsageFigure bytes={summary.chargedBytes} /> of <UsageFigure bytes={usage.limitBytes} />
        </span>
      </div>

      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={usage.limitBytes}
        aria-valuenow={summary.chargedBytes}
        aria-valuetext={summary.valueText}
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border"
      >
        <div
          aria-hidden="true"
          data-testid="storage-used-segment"
          className={cn(
            "h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            summary.severity === "full" ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${summary.usedPercent}%` }}
        />
        <div
          aria-hidden="true"
          data-testid="storage-pending-segment"
          className={cn(
            "h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            summary.severity === "full" ? "bg-destructive/60" : "bg-primary/60",
          )}
          style={{ width: `${summary.pendingPercent}%`, backgroundImage: PENDING_HATCH }}
        />
      </div>

      {severityMessage !== null ? (
        <p
          className={cn(
            "flex items-start gap-2 text-sm font-medium",
            summary.severity === "full" ? "text-destructive" : "text-warning",
          )}
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{severityMessage}</span>
        </p>
      ) : null}

      <dl className="space-y-1 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">Files stored</dt>
          <dd className="font-medium">
            <UsageFigure bytes={usage.usedBytes} />{" "}
            <span className="font-normal text-muted-foreground">
              ({usage.attachmentCount === 1 ? "1 file" : `${usage.attachmentCount} files`})
            </span>
          </dd>
        </div>
        {summary.hasPending ? (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Uploading now</dt>
            <dd className="font-medium">
              <UsageFigure bytes={usage.pendingBytes} />
            </dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">Available</dt>
          <dd className="font-medium">
            <UsageFigure bytes={usage.availableBytes} />
          </dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">{summary.limitSourceLabel}</p>
    </div>
  );
}
