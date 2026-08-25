"use client";

import { AUDIT_LOG_EXPORT_MAX_ROWS } from "@notted/shared-validators";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { AuditLogFilters, AuditLogPage } from "@notted/shared-types";
import type { FormEvent } from "react";

import { auditLogExportUrl, listAuditLogs } from "@/lib/audit-logs/requests";

/**
 * Part 71 — the workspace administrative view of the audit trail.
 *
 * Modelled on `ApiKeys`: local state, no TanStack Query, one `load` callback
 * driven by an effect. There is one reader here too, so a query cache buys
 * nothing yet.
 *
 * ponytail: local state, no query client. Same upgrade path as `ApiKeys` —
 * move onto the query client if a second surface ever needs this page.
 */

const PERMISSION_MESSAGE = "You need to be a workspace admin to view the audit log.";
const PAGE_LIMIT = 25;

function failureMessage(kind: ApiRequestFailureKind): string {
  return kind === "forbidden-or-not-found"
    ? PERMISSION_MESSAGE
    : "The audit log could not be loaded. Nothing was changed.";
}

/** A date-only `from` is the start of that day, in UTC. */
function startOfDay(date: string): string | undefined {
  if (date === "") return undefined;
  const at = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** A date-only `to` is the end of that day, in UTC — mirrors `ApiKeys`' `expiryTimestamp`. */
function endOfDay(date: string): string | undefined {
  if (date === "") return undefined;
  const at = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function AuditLog({ workspaceId }: { readonly workspaceId: string }) {
  const [page, setPage] = useState<AuditLogPage | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiRequestFailureKind | null>(null);
  const [status, setStatus] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [filters, setFilters] = useState<AuditLogFilters>({});

  const [actionInput, setActionInput] = useState("");
  const [entityTypeInput, setEntityTypeInput] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");

  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setLoadFailure(null);
    const result = await listAuditLogs(workspaceId, {
      page: pageNumber,
      limit: PAGE_LIMIT,
      ...filters,
    });
    if (result.ok) {
      setPage(result.data);
      return;
    }
    setPage(null);
    setLoadFailure(result.kind);
  }, [workspaceId, pageNumber, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setStatus("");
    setPageNumber(1);
    setFilters({
      action: trimmedOrUndefined(actionInput),
      entityType: trimmedOrUndefined(entityTypeInput),
      userId: trimmedOrUndefined(actorInput),
      from: startOfDay(fromInput),
      to: endOfDay(toInput),
    });
  }

  function clearFilters(): void {
    setActionInput("");
    setEntityTypeInput("");
    setActorInput("");
    setFromInput("");
    setToInput("");
    setStatus("");
    setPageNumber(1);
    setFilters({});
  }

  return (
    <section aria-labelledby="audit-log-heading" className="space-y-4 rounded-md border p-4">
      <h2 id="audit-log-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        Audit log
      </h2>
      <p className="text-sm text-muted-foreground">
        A read-only record of actions taken in this workspace.
      </p>

      <form role="search" onSubmit={applyFilters} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="audit-log-action" className="block text-sm font-medium">
            Action
          </label>
          <input
            id="audit-log-action"
            type="text"
            value={actionInput}
            onChange={(event) => setActionInput(event.target.value)}
            className="min-h-11 w-full rounded-md border px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="audit-log-entity-type" className="block text-sm font-medium">
            Entity type
          </label>
          <input
            id="audit-log-entity-type"
            type="text"
            value={entityTypeInput}
            onChange={(event) => setEntityTypeInput(event.target.value)}
            className="min-h-11 w-full rounded-md border px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="audit-log-actor" className="block text-sm font-medium">
            Actor user id
          </label>
          <input
            id="audit-log-actor"
            type="text"
            value={actorInput}
            onChange={(event) => setActorInput(event.target.value)}
            className="min-h-11 w-full rounded-md border px-3 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="audit-log-from" className="block text-sm font-medium">
              From
            </label>
            {/* Native date input: no picker library, keyboard operable everywhere. */}
            <input
              id="audit-log-from"
              type="date"
              value={fromInput}
              onChange={(event) => setFromInput(event.target.value)}
              className="min-h-11 w-full rounded-md border px-3 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="audit-log-to" className="block text-sm font-medium">
              To
            </label>
            <input
              id="audit-log-to"
              type="date"
              value={toInput}
              onChange={(event) => setToInput(event.target.value)}
              className="min-h-11 w-full rounded-md border px-3 text-sm"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Apply filters
          </button>
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
          >
            Clear filters
          </button>
        </div>
      </form>

      {loadFailure !== null ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{failureMessage(loadFailure)}</p>
          {loadFailure === "forbidden-or-not-found" ? null : (
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
            >
              Try again
            </button>
          )}
        </div>
      ) : page === null ? (
        <p className="text-sm text-muted-foreground">Loading audit log…</p>
      ) : page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit events match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Audit log entries for this workspace</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="p-2 font-medium">
                  When
                </th>
                <th scope="col" className="p-2 font-medium">
                  Action
                </th>
                <th scope="col" className="p-2 font-medium">
                  Entity
                </th>
                <th scope="col" className="p-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="p-2 font-medium">
                  Address
                </th>
                <th scope="col" className="p-2 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="p-2 align-top">{new Date(item.createdAt).toLocaleString()}</td>
                  <td className="p-2 align-top">{item.action}</td>
                  <td className="p-2 align-top">{item.entityType}</td>
                  <td className="p-2 align-top">{item.userName ?? item.userId ?? "System"}</td>
                  <td className="p-2 align-top">{item.ipAddress ?? "—"}</td>
                  <td className="p-2 align-top">
                    <details>
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium">
                        Details
                      </summary>
                      <dl className="space-y-1 pb-2 text-xs text-muted-foreground">
                        <div>
                          <dt className="inline font-medium">Entity id: </dt>
                          <dd className="inline">{item.entityId}</dd>
                        </div>
                        <div>
                          <dt className="inline font-medium">User agent: </dt>
                          <dd className="inline">{item.userAgent ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="inline font-medium">Request id: </dt>
                          <dd className="inline">{item.requestId ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="inline font-medium">Metadata: </dt>
                          {/* Never dangerouslySetInnerHTML: this is server-recorded JSON, rendered as plain text. */}
                          <dd className="inline break-all">{JSON.stringify(item.metadata)}</dd>
                        </div>
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page === null ? null : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
            className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
          >
            Previous
          </button>
          <span>Page {pageNumber}</span>
          <button
            type="button"
            disabled={!page.hasMore}
            onClick={() => setPageNumber((current) => current + 1)}
            className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
          >
            Next
          </button>
        </div>
      )}

      <div className="space-y-1">
        <a
          href={auditLogExportUrl(workspaceId, filters)}
          download
          className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
        >
          Export CSV
        </a>
        <p className="text-xs text-muted-foreground">
          Exports are capped at {AUDIT_LOG_EXPORT_MAX_ROWS.toLocaleString()} rows and reflect the
          current filters.
        </p>
      </div>

      {/* One live region, and only for text that has no box of its own. */}
      <p aria-live="polite" aria-atomic="true" className="min-h-5 text-sm text-muted-foreground">
        {loadFailure === null ? status : ""}
      </p>
    </section>
  );
}
