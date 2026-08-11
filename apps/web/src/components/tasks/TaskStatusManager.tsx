"use client";

import {
  createTaskStatusSchema,
  taskStatusColorSchema,
  taskStatusNameSchema,
} from "@notted/shared-validators";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { CustomTaskStatus } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-controls";
import { createTaskStatus, deleteTaskStatus, updateTaskStatus } from "@/lib/tasks/requests";

/** Neutral grey: the server picks its own default, this only pre-fills the form. */
const DEFAULT_COLOR = "#6b7280";

function failureMessage(action: string, kind: ApiRequestFailureKind): string {
  if (kind === "forbidden-or-not-found")
    return `${action} was denied or the column is no longer available. Nothing was changed.`;
  if (kind === "conflict" || kind === "version-conflict")
    return `${action} conflicted with a recent change by someone else. Nothing was changed; reload and retry.`;
  if (kind === "invalid") return `${action} was not accepted. Nothing was changed.`;
  return `${action} could not reach Notted. Nothing was changed; check your connection and retry.`;
}

/** First client-side complaint about a name and colour pair, or `null`. */
function fieldProblem(name: string, color: string): string | null {
  const parsedName = taskStatusNameSchema.safeParse(name);
  if (!parsedName.success) {
    return parsedName.error.issues[0]?.message ?? "Enter a column name of 1 to 50 characters.";
  }
  return taskStatusColorSchema.safeParse(color).success
    ? null
    : "Use a six-digit hex colour such as #6b7280.";
}

function StatusRow({
  status,
  cards,
  disabled,
  onSave,
  onDelete,
}: {
  readonly status: CustomTaskStatus;
  readonly cards: number;
  readonly disabled: boolean;
  readonly onSave: (status: CustomTaskStatus, name: string, color: string) => void;
  readonly onDelete: (status: CustomTaskStatus) => void;
}) {
  // `null` means "show the persisted row", so a refetch cannot reset a field
  // under the user's cursor while an edit is open.
  const [draft, setDraft] = useState<{ readonly name: string; readonly color: string } | null>(
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const name = draft?.name ?? status.name;
  const color = draft?.color ?? status.color;
  const problem = fieldProblem(name, color);
  const dirty = draft !== null && (name !== status.name || color !== status.color);

  return (
    <li className="space-y-3 rounded-lg border p-3">
      <form
        className="flex flex-wrap items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem !== null) return;
          onSave(status, name.trim(), color);
          setDraft(null);
        }}
      >
        <FormField
          id={`task-status-${status.id}-name`}
          label={`Name for ${status.name}`}
          value={name}
          maxLength={50}
          autoComplete="off"
          disabled={disabled || status.isBuiltIn}
          className="min-h-11 w-44"
          error={problem ?? undefined}
          onChange={(event) => setDraft({ name: event.target.value, color })}
        />
        <FormField
          id={`task-status-${status.id}-color`}
          label={`Colour hex for ${status.name}`}
          value={color}
          maxLength={7}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || status.isBuiltIn}
          className="min-h-11 w-32 font-mono"
          onChange={(event) => setDraft({ name, color: event.target.value })}
        />
        <p className="mt-7 text-sm text-muted-foreground">
          {cards} {cards === 1 ? "card" : "cards"} on this board
        </p>
        {status.isBuiltIn ? (
          <p className="mt-7 text-sm text-muted-foreground" role="note">
            Seeded column: it cannot be renamed or deleted.
          </p>
        ) : (
          <>
            <Button
              type="submit"
              variant="outline"
              className="mt-7 min-h-11"
              disabled={disabled || !dirty || problem !== null}
            >
              Save
              <span className="sr-only"> {status.name}</span>
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="mt-7 min-h-11"
              disabled={disabled}
              onClick={() => setConfirming(true)}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              Delete
              <span className="sr-only"> {status.name}</span>
            </Button>
          </>
        )}
      </form>
      {confirming ? (
        <div className="space-y-3 rounded-md border border-destructive p-3" role="alert">
          <p className="text-sm">
            Delete the column “{status.name}”? At least {cards}{" "}
            {cards === 1 ? "card moves" : "cards move"} back to their built-in status. Any notes
            placed in this column lose their board column, and a note has no built-in status to fall
            back to. Nothing is deleted, and this cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={disabled}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={disabled}
              onClick={() => {
                setConfirming(false);
                onDelete(status);
              }}
            >
              Delete column
              <span className="sr-only"> {status.name}</span>
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Create, rename, recolour and delete the board's custom columns.
 *
 * Rendered only for owner and admin, because the three mutations behind it
 * require `settings.update`. There is no settings sub-route: columns are edited
 * where they are seen. Every mutation refetches rather than writing an
 * optimistic cache entry — this is a low-frequency admin dialog, and the extra
 * round trip buys a much smaller rollback surface.
 */
export function TaskStatusManager({
  workspaceId,
  projectId,
  statuses,
  isLoading,
  isError,
  cardCounts,
  onRetry,
  onChanged,
}: {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly statuses: readonly CustomTaskStatus[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** Cards currently shown in each custom column, keyed by status id. */
  readonly cardCounts: ReadonlyMap<string, number>;
  readonly onRetry: () => void;
  readonly onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const createProblem = name === "" ? null : fieldProblem(name, color);

  async function create(): Promise<void> {
    const parsed = createTaskStatusSchema.safeParse({ projectId, name, color });
    if (!parsed.success) {
      // Rejected before any request: an empty, reserved or over-long name is a
      // client mistake, and a round trip would only turn it into a 400.
      setStatus(
        `The column was not created. ${parsed.error.issues[0]?.message ?? "Check the name and colour"}.`,
      );
      return;
    }
    setPending(true);
    setStatus(`Creating ${parsed.data.name}…`);
    const result = await createTaskStatus(workspaceId, parsed.data, globalThis.crypto.randomUUID());
    setPending(false);
    if (!result.ok) {
      setStatus(failureMessage("Creating the column", result.kind));
      return;
    }
    setName("");
    setColor(DEFAULT_COLOR);
    setStatus(`Created ${result.data.status.name}.`);
    onChanged();
  }

  async function save(
    target: CustomTaskStatus,
    nextName: string,
    nextColor: string,
  ): Promise<void> {
    setPending(true);
    setStatus(`Saving ${target.name}…`);
    const result = await updateTaskStatus(workspaceId, target.id, {
      name: nextName,
      color: nextColor,
    });
    setPending(false);
    if (!result.ok) {
      setStatus(failureMessage("The column update", result.kind));
      return;
    }
    setStatus(`Saved ${result.data.status.name}.`);
    onChanged();
  }

  async function remove(target: CustomTaskStatus): Promise<void> {
    setPending(true);
    setStatus(`Deleting ${target.name}…`);
    const result = await deleteTaskStatus(workspaceId, target.id);
    setPending(false);
    if (!result.ok) {
      setStatus(failureMessage("Deleting the column", result.kind));
      return;
    }
    // The server's true counts — the board only ever knew about the cards on
    // this page, and it never knew about notes at all. Notes are reported
    // separately because they lose their placement outright: unlike a task,
    // a note has no built-in status underneath the custom column.
    const { affected, affectedNotes } = result.data;
    setStatus(
      `Deleted ${target.name}. ${affected} ${affected === 1 ? "task" : "tasks"} moved back to ` +
        `their built-in status; ${affectedNotes} ` +
        `${affectedNotes === 1 ? "note lost its" : "notes lost their"} board column.`,
    );
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Manage board columns
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage board columns</DialogTitle>
          <DialogDescription>
            Custom columns sit after the four built-in ones. A card in a custom column keeps its
            built-in status, so completion never changes when a column does.
          </DialogDescription>
        </DialogHeader>

        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-h-6 text-sm text-muted-foreground"
        >
          {status}
        </p>

        <form
          className="flex flex-wrap items-start gap-3 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <FormField
            id="create-task-status-name"
            label="New column name"
            value={name}
            maxLength={50}
            autoComplete="off"
            disabled={pending}
            className="min-h-11 w-44"
            error={createProblem ?? undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <FormField
            id="create-task-status-color"
            label="New column colour hex"
            value={color}
            maxLength={7}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            className="min-h-11 w-32 font-mono"
            onChange={(event) => setColor(event.target.value)}
          />
          <Button
            type="submit"
            className="mt-7 min-h-11"
            disabled={pending || name === "" || createProblem !== null}
          >
            Add column
          </Button>
        </form>

        {isError ? (
          <div className="space-y-3 rounded-md border p-3" role="alert">
            <p className="text-sm">
              The custom columns could not be loaded. None of them was changed; the four built-in
              columns are unaffected.
            </p>
            <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading columns…</p>
        ) : statuses.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No custom columns yet. Add one above; the four built-in columns are always present.
          </p>
        ) : (
          <ul aria-label="Custom board columns" className="space-y-3">
            {statuses.map((entry) => (
              <StatusRow
                key={entry.id}
                status={entry}
                cards={cardCounts.get(entry.id) ?? 0}
                disabled={pending}
                onSave={(target, nextName, nextColor) => void save(target, nextName, nextColor)}
                onDelete={(target) => void remove(target)}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
