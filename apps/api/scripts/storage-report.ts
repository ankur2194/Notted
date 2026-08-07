// Part 45: the dry-run storage-maintenance report CLI.
//
// WHY IT EXISTS
// `STORAGE_MAINTENANCE_ENABLED` defaults to `false` precisely so that nothing
// sweeps until an operator has seen what a sweep would do to THEIR data. This is
// that report: it runs the four sweeps in dry-run mode against the configured
// database and bucket and prints the counts. Reviewing this output is the step
// that comes before setting `STORAGE_MAINTENANCE_DRY_RUN=true`, which in turn
// comes before enabling destructive sweeps.
//
// REPORT ONLY, BY CONSTRUCTION
// `runSystemSweeps` is called with a literal `true` — not a variable, not a
// parsed flag — and the argument parser rejects every option. There is no input
// to this script, from any caller or environment variable, that can make it
// delete a row or an object. Making it destructive would require editing this
// file, which is a reviewed change rather than a typo at a shell prompt.
//
// WHY A NEST APPLICATION CONTEXT
// `StorageMaintenanceService` depends on the database pool, the object-storage
// client, the tenant context, and two config providers. Re-wiring those by hand
// here would be a second, untested copy of the composition root — and it would
// be the copy an operator's safety decision rests on. `AppModule` is the root
// rather than `MaintenanceModule` because `DatabaseModule` and
// `TenantContextModule` are `@Global()`: they only register when the module that
// declares them is in the graph, so a narrower root cannot resolve the service.
//
// Booting that graph also constructs `StorageMaintenanceScheduler`, but it never
// sweeps here: it deliberately does not kick at startup, its shortest legal
// interval is 60 seconds, and `app.close()` clears the timer through
// `onApplicationShutdown` long before a first tick could arrive.
//
// OUTPUT IS SAFE TO PASTE INTO A TICKET
// Sweep names, counts, fixed-vocabulary note codes, and resource UUIDs only. The
// report contract carries nothing else — no filename, object key, signed URL, or
// document content ever reaches it (`docs/standards/observability.md`) — so
// there is nothing here to redact.
//
// Run it with `pnpm --filter @notted/api storage:report`.

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module";
import { StorageMaintenanceService } from "../src/maintenance/storage-maintenance.service";

import type { StorageMaintenanceReport, StorageMaintenanceSweepReport } from "@notted/shared-types";

/**
 * An error whose message this file authored, and which is therefore safe to
 * print verbatim. Everything else is reported without its message — see the
 * entrypoint's catch for why.
 */
class StorageReportError extends Error {}

interface ReportColumn {
  readonly header: string;
  readonly alignRight: boolean;
  readonly value: (sweep: StorageMaintenanceSweepReport) => string;
}

/**
 * The columns worth showing for a DRY RUN.
 *
 * `rowsRemoved`, `rowsMarked`, and `objectsRemoved` are omitted deliberately:
 * they are always `0` in a dry run, so three zero columns would only crowd out
 * the number that matters. `selected` is the count a real run would act on.
 */
const REPORT_COLUMNS: readonly ReportColumn[] = [
  { header: "sweep", alignRight: false, value: (sweep) => sweep.sweep },
  { header: "examined", alignRight: true, value: (sweep) => String(sweep.examined) },
  { header: "selected", alignRight: true, value: (sweep) => String(sweep.selected) },
  { header: "samples", alignRight: true, value: (sweep) => String(sweep.sampleIds.length) },
  { header: "truncated", alignRight: true, value: (sweep) => (sweep.truncated ? "yes" : "no") },
];

/**
 * Reject every option instead of ignoring unknown ones.
 *
 * A script whose entire safety property is "it cannot delete" must not appear to
 * accept a flag it silently drops: an operator who typed `--apply` should be
 * told plainly that no such mode exists, not left believing the run was
 * destructive. The bare `--` that pnpm forwards is filtered rather than
 * rejected, matching `scripts/validate-env.ts`.
 */
export function assertReportOnlyArguments(argumentsList: readonly string[]): void {
  const supplied = argumentsList.filter((value) => value !== "--");
  if (supplied.length > 0) {
    throw new StorageReportError(
      "storage:report accepts no options: it is a dry-run report and has no destructive mode.",
    );
  }
}

/** Fixed-width sweep table, padded from the data. No colour, no dependencies. */
export function renderSweepTable(sweeps: readonly StorageMaintenanceSweepReport[]): string {
  const rows = sweeps.map((sweep) => REPORT_COLUMNS.map((column) => column.value(sweep)));
  const widths = REPORT_COLUMNS.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const cell = (text: string, index: number): string => {
    const width = widths[index] ?? text.length;
    return REPORT_COLUMNS[index]?.alignRight === true ? text.padStart(width) : text.padEnd(width);
  };
  const line = (cells: readonly string[]): string => cells.map(cell).join("  ");
  return [
    line(REPORT_COLUMNS.map((column) => column.header)),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(row)),
  ].join("\n");
}

/**
 * Per-sweep note codes and UUID samples.
 *
 * Both come straight from the report's fixed vocabularies, so this function
 * never has to decide whether a value is safe to print.
 */
export function renderSweepDetails(
  sweeps: readonly StorageMaintenanceSweepReport[],
): readonly string[] {
  const lines: string[] = [];
  for (const sweep of sweeps) {
    if (sweep.notes.length === 0 && sweep.sampleIds.length === 0) continue;
    lines.push(`${sweep.sweep}:`);
    if (sweep.notes.length > 0) lines.push(`  notes:      ${sweep.notes.join(", ")}`);
    if (sweep.sampleIds.length > 0) lines.push(`  sample ids: ${sweep.sampleIds.join(", ")}`);
  }
  return lines;
}

export function renderReport(report: StorageMaintenanceReport): string {
  const details = renderSweepDetails(report.sweeps);
  return [
    "Storage maintenance DRY RUN — nothing was deleted or modified.",
    `scope=${report.scope}  startedAt=${report.startedAt}  finishedAt=${report.finishedAt}`,
    "",
    renderSweepTable(report.sweeps),
    "",
    "`selected` counts what a real run would act on. `truncated` means the batch",
    "bound was reached and a further pass would still have work left.",
    ...(details.length === 0 ? [] : ["", ...details]),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  assertReportOnlyArguments(process.argv.slice(2));
  // `logger: false` silences Nest's boot banner so the table is the only thing
  // on stdout and the output stays pasteable.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  let report: StorageMaintenanceReport;
  try {
    report = await app.get(StorageMaintenanceService).runSystemSweeps({ dryRun: true });
  } finally {
    // In `finally` so a failed sweep still releases the pool and clears the
    // scheduler's timer instead of hanging the process.
    await app.close();
  }
  // Defence in depth: the report echoes the mode it ran in, so a service that
  // ever ignored `dryRun` is caught and reported rather than printed as if it
  // had only looked.
  if (!report.dryRun) {
    throw new StorageReportError(
      "Storage maintenance report refused: the run did not report itself as a dry run.",
    );
  }
  process.stdout.write(renderReport(report));
}

main().catch((error: unknown) => {
  // A third-party exception message is NOT interpolated. A storage or database
  // client can put an endpoint, a bucket, or an object key in one, and none of
  // those belong in a terminal transcript or a pasted ticket. The class name is
  // a code identifier carrying no payload, so it is safe to name. Messages this
  // file wrote itself are printed in full, because they are what tells an
  // operator they mistyped an option.
  process.stderr.write(
    error instanceof StorageReportError
      ? `${error.message}\n`
      : `Storage maintenance report failed (${error instanceof Error ? error.name : "Error"}). ` +
          "Check the API service logs for the structured per-sweep records.\n",
  );
  process.exitCode = 1;
});
