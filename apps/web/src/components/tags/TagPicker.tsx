"use client";

import type { TagSummary } from "@notted/shared-types";

/**
 * Presentational, fully controlled tag selector.
 *
 * It owns no server state on purpose: Part 46 uses it for a note's tags and
 * Part 47 reuses it for a task's tags, and those two persist through different
 * endpoints. Anything it fetched or saved itself would have to be undone by
 * one of the two callers.
 */
export function TagPicker({
  tags,
  value,
  onChange,
  disabled = false,
  legend = "Tags",
  idPrefix,
}: {
  readonly tags: readonly TagSummary[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly disabled?: boolean;
  readonly legend?: string;
  /** Namespaces the checkbox ids so two pickers on one page never collide. */
  readonly idPrefix: string;
}) {
  const selected = new Set(value);

  function toggle(tagId: string): void {
    // Rebuilt from `tags`, never from click order, so a caller diffing the
    // array (or persisting it) sees a stable, comparable ordering.
    const next = tags
      .map((tag) => tag.id)
      .filter((id) => (id === tagId ? !selected.has(id) : selected.has(id)));
    // Ids selected but no longer offered are kept: the picker must not silently
    // detach a tag it simply was not given.
    const unknown = value.filter((id) => !tags.some((tag) => tag.id === id));
    onChange([...next, ...unknown]);
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      {tags.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No tags yet. Create a tag on the workspace tags page before assigning one here.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {tags.map((tag) => {
            const id = `${idPrefix}-tag-${tag.id}`;
            return (
              <li key={tag.id}>
                <label
                  htmlFor={id}
                  className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm focus-within:ring-2 focus-within:ring-ring"
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    checked={selected.has(tag.id)}
                    disabled={disabled}
                    onChange={() => toggle(tag.id)}
                  />
                  <span
                    aria-hidden="true"
                    style={{ backgroundColor: tag.color }}
                    className="size-2.5 shrink-0 rounded-full"
                  />
                  <span>{tag.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
