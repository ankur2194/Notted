"use client";

import type { SearchSort, SearchSortDirection } from "@notted/shared-types";

const SELECT_CLASSES =
  "min-h-11 rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50";
const DATE_INPUT_CLASSES =
  "min-h-11 rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50";

export interface SearchFilterValues {
  /** Project id filter, or "" for "Any project". */
  readonly projectId: string;
  /** Author (member userId) filter, or "" for "Anyone". */
  readonly authorId: string;
  /** `YYYY-MM-DD` lower bound for `createdAt`, or "". */
  readonly createdFrom: string;
  /** `YYYY-MM-DD` upper bound for `createdAt`, or "". */
  readonly createdTo: string;
  /** `YYYY-MM-DD` lower bound for `updatedAt`, or "". */
  readonly updatedFrom: string;
  /** `YYYY-MM-DD` upper bound for `updatedAt`, or "". */
  readonly updatedTo: string;
  /** Attachment filter: "" (any) | "true" | "false". */
  readonly hasAttachments: "" | "true" | "false";
  readonly sortBy: SearchSort;
  readonly sortDirection: SearchSortDirection;
}

export interface ProjectFilterOption {
  readonly id: string;
  readonly name: string;
}

export interface MemberFilterOption {
  readonly userId: string;
  readonly name: string;
}

const SORT_OPTIONS: readonly { readonly value: SearchSort; readonly label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "createdAt", label: "Date created" },
  { value: "updatedAt", label: "Date updated" },
];

const SORT_DIRECTION_OPTIONS: readonly {
  readonly value: SearchSortDirection;
  readonly label: string;
}[] = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

const ATTACHMENT_OPTIONS: readonly {
  readonly value: "" | "true" | "false";
  readonly label: string;
}[] = [
  { value: "", label: "Any" },
  { value: "true", label: "Has attachments" },
  { value: "false", label: "No attachments" },
];

export function SearchFilters({
  values,
  projects,
  members,
  onChange,
  onClear,
}: {
  readonly values: SearchFilterValues;
  readonly projects: readonly ProjectFilterOption[];
  readonly members: readonly MemberFilterOption[];
  readonly onChange: (next: Partial<SearchFilterValues>) => void;
  readonly onClear: () => void;
}) {
  const hasActiveFilter =
    values.projectId !== "" ||
    values.authorId !== "" ||
    values.createdFrom !== "" ||
    values.createdTo !== "" ||
    values.updatedFrom !== "" ||
    values.updatedTo !== "" ||
    values.hasAttachments !== "" ||
    values.sortBy !== "relevance" ||
    values.sortDirection !== "desc";

  return (
    <section aria-label="Search filters" className="rounded-lg border bg-card p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="search-filter-project">
            Project
          </label>
          <select
            id="search-filter-project"
            className={SELECT_CLASSES}
            value={values.projectId}
            onChange={(event) => onChange({ projectId: event.target.value })}
          >
            <option value="">Any project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="search-filter-author">
            Author
          </label>
          <select
            id="search-filter-author"
            className={SELECT_CLASSES}
            value={values.authorId}
            onChange={(event) => onChange({ authorId: event.target.value })}
          >
            <option value="">Anyone</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="search-filter-attachments">
            Attachments
          </label>
          <select
            id="search-filter-attachments"
            className={SELECT_CLASSES}
            value={values.hasAttachments}
            onChange={(event) =>
              onChange({ hasAttachments: event.target.value as "" | "true" | "false" })
            }
          >
            {ATTACHMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Created date range</legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="search-filter-created-from">
              Created from
            </label>
            <input
              id="search-filter-created-from"
              type="date"
              className={DATE_INPUT_CLASSES}
              value={values.createdFrom}
              onChange={(event) => onChange({ createdFrom: event.target.value })}
            />
            <span aria-hidden="true" className="text-sm text-muted-foreground">
              to
            </span>
            <label className="sr-only" htmlFor="search-filter-created-to">
              Created to
            </label>
            <input
              id="search-filter-created-to"
              type="date"
              className={DATE_INPUT_CLASSES}
              value={values.createdTo}
              onChange={(event) => onChange({ createdTo: event.target.value })}
            />
          </div>
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Updated date range</legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="search-filter-updated-from">
              Updated from
            </label>
            <input
              id="search-filter-updated-from"
              type="date"
              className={DATE_INPUT_CLASSES}
              value={values.updatedFrom}
              onChange={(event) => onChange({ updatedFrom: event.target.value })}
            />
            <span aria-hidden="true" className="text-sm text-muted-foreground">
              to
            </span>
            <label className="sr-only" htmlFor="search-filter-updated-to">
              Updated to
            </label>
            <input
              id="search-filter-updated-to"
              type="date"
              className={DATE_INPUT_CLASSES}
              value={values.updatedTo}
              onChange={(event) => onChange({ updatedTo: event.target.value })}
            />
          </div>
        </fieldset>

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-sm font-medium" htmlFor="search-filter-sort-by">
              Sort by
            </label>
            <select
              id="search-filter-sort-by"
              className={SELECT_CLASSES}
              value={values.sortBy}
              onChange={(event) => onChange({ sortBy: event.target.value as SearchSort })}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-sm font-medium" htmlFor="search-filter-sort-direction">
              Direction
            </label>
            <select
              id="search-filter-sort-direction"
              className={SELECT_CLASSES}
              value={values.sortDirection}
              onChange={(event) =>
                onChange({ sortDirection: event.target.value as SearchSortDirection })
              }
            >
              {SORT_DIRECTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {hasActiveFilter ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={onClear}
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear filters
          </button>
        </div>
      ) : null}
    </section>
  );
}
