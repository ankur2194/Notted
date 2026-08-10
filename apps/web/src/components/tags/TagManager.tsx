"use client";

import { createTagSchema, TAG_COLOR_PATTERN, TAG_DEFAULT_COLOR } from "@notted/shared-validators";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { TagListQuery, TagPage, TagSummary } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-controls";
import { tagQueryKeys } from "@/lib/notes/query-keys";
import { createTag, deleteTag, requestTagPage, updateTag } from "@/lib/tags/requests";

/**
 * The whole listing, alphabetically. `tagPageSchema` caps `limit` at 100, so a
 * workspace past that reports `hasMore` and says so rather than silently
 * hiding tags.
 */
const TAG_QUERY: TagListQuery = {
  page: 1,
  limit: 100,
  sortBy: "name",
  sortDirection: "asc",
};

const HEX_HINT = "Use a six-digit hex colour such as #6b7280";

function failureMessage(action: string, kind: ApiRequestFailureKind, code?: string): string {
  const restored = "The previous list was restored";
  // Both tag conflicts are 409, but the remedies are opposite: renaming fixes a
  // duplicate name and can never fix a full workspace. Telling a workspace at
  // its tag limit to "choose a different name" is advice that always fails.
  if (code === "TAG_LIMIT_REACHED")
    return `${action} was refused: this workspace has reached its tag limit. ${restored}; delete a tag you no longer use before adding another.`;
  if (kind === "conflict")
    return `${action} conflicted: a tag with that name already exists in this workspace. ${restored}; choose a different name.`;
  if (kind === "version-conflict")
    return `${action} conflicted with a newer saved version. ${restored}; reload before retrying.`;
  if (kind === "forbidden-or-not-found")
    return `${action} was denied or the tag is no longer available. ${restored}.`;
  if (kind === "invalid") return `${action} was not accepted. ${restored}.`;
  return `${action} could not reach Notted. ${restored}; check your connection and retry.`;
}

function usage(tag: TagSummary): string {
  return `${tag.noteCount} notes, ${tag.taskCount} tasks`;
}

/**
 * A native colour input paired with a hex text input.
 *
 * The text field is the source of truth for submission: `<input type="color">`
 * is unreachable for keyboard-only and screen reader users on several
 * platforms, and its value is never legible as text.
 */
function ColorField({
  idPrefix,
  swatchLabel,
  hexLabel,
  value,
  disabled,
  onChange,
}: {
  readonly idPrefix: string;
  readonly swatchLabel: string;
  readonly hexLabel: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}) {
  const valid = TAG_COLOR_PATTERN.test(value);
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="space-y-2">
        <label htmlFor={`${idPrefix}-color`} className="block text-sm font-medium text-foreground">
          {swatchLabel}
        </label>
        <input
          id={`${idPrefix}-color`}
          type="color"
          disabled={disabled}
          value={valid ? value : TAG_DEFAULT_COLOR}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="h-11 w-16 rounded-md border bg-background p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <FormField
        id={`${idPrefix}-color-hex`}
        label={hexLabel}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        maxLength={7}
        className="min-h-11 w-36 font-mono"
        error={valid ? undefined : HEX_HINT}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function TagRow({
  tag,
  canManage,
  canDelete,
  disabled,
  onSave,
  onDelete,
}: {
  readonly tag: TagSummary;
  readonly canManage: boolean;
  readonly canDelete: boolean;
  readonly disabled: boolean;
  readonly onSave: (tag: TagSummary, name: string, color: string) => Promise<void>;
  readonly onDelete: (tag: TagSummary) => Promise<void>;
}) {
  // `null` means "show the persisted row". Deriving the displayed value instead
  // of mirroring the prop into state keeps an optimistic update from resetting
  // the field under the user's cursor.
  const [draft, setDraft] = useState<{ readonly name: string; readonly color: string } | null>(
    null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const name = draft?.name ?? tag.name;
  const color = draft?.color ?? tag.color;
  const dirty = draft !== null && (draft.name !== tag.name || draft.color !== tag.color);

  return (
    <li
      aria-label={`${tag.name}, ${usage(tag)}`}
      className="flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4"
    >
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 font-medium">
          <span
            aria-hidden="true"
            style={{ backgroundColor: tag.color }}
            className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
          />
          <span className="truncate">{tag.name}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          {tag.noteCount} notes · {tag.taskCount} tasks
        </p>
      </div>
      {canManage ? (
        <form
          className="flex flex-wrap items-start gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(tag, name, color).then(() => setDraft(null));
          }}
        >
          <FormField
            id={`tag-${tag.id}-name`}
            label={`Name for ${tag.name}`}
            value={name}
            disabled={disabled}
            maxLength={50}
            autoComplete="off"
            className="min-h-11 w-48"
            onChange={(event) => setDraft({ name: event.target.value, color })}
          />
          <ColorField
            idPrefix={`tag-${tag.id}`}
            swatchLabel={`Colour for ${tag.name}`}
            hexLabel={`Colour hex for ${tag.name}`}
            value={color}
            disabled={disabled}
            onChange={(next) => setDraft({ name, color: next })}
          />
          <Button
            type="submit"
            variant="outline"
            className="mt-7 min-h-11"
            disabled={disabled || !dirty}
          >
            Save
          </Button>
          {canDelete ? (
            <Dialog
              open={confirmOpen}
              onOpenChange={(open) => {
                if (!disabled) setConfirmOpen(open);
              }}
            >
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  className="mt-7 min-h-11"
                  disabled={disabled}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Delete
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete the tag “{tag.name}”?</DialogTitle>
                  <DialogDescription>
                    Used on {tag.noteCount} notes and {tag.taskCount} tasks. Deleting removes it
                    from all of them. The notes and tasks themselves are kept. This cannot be
                    undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" disabled={disabled}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => {
                      setConfirmOpen(false);
                      void onDelete(tag);
                    }}
                  >
                    Delete tag
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

export function TagManager({
  workspaceId,
  initialTags,
  canManage,
  canDelete,
}: {
  readonly workspaceId: string;
  readonly initialTags: TagPage;
  readonly canManage: boolean;
  readonly canDelete: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_DEFAULT_COLOR);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);

  const tagsQuery = useQuery({
    queryKey: tagQueryKeys.list(workspaceId, TAG_QUERY),
    initialData: initialTags,
    queryFn: async () => {
      const result = await requestTagPage(workspaceId, TAG_QUERY);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });
  const page = tagsQuery.data;
  const operationPending = pendingIds.size > 0;

  function setPage(next: TagPage): void {
    queryClient.setQueryData(tagQueryKeys.list(workspaceId, TAG_QUERY), next);
  }

  function markPending(tagId: string, pending: boolean): void {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(tagId);
      else next.delete(tagId);
      return next;
    });
  }

  async function reconcile(): Promise<void> {
    await tagsQuery.refetch();
    router.refresh();
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = createTagSchema.safeParse({ name, color });
    if (!parsed.success) {
      // Rejected here, before any request: an invalid colour or an empty name
      // is a client mistake, and a round trip would only turn it into a 400.
      setStatus(`Tag creation was not accepted. ${parsed.error.issues[0]?.message ?? HEX_HINT}.`);
      return;
    }
    const snapshot: TagPage = { ...page, items: [...page.items] };
    const temporaryId = globalThis.crypto.randomUUID();
    const temporary: TagSummary = {
      id: temporaryId,
      workspaceId,
      name: parsed.data.name,
      color: parsed.data.color,
      noteCount: 0,
      taskCount: 0,
      createdAt: new Date().toISOString(),
    };
    setPage({ ...page, items: [temporary, ...page.items] });
    markPending(temporaryId, true);
    setStatus(`Creating ${temporary.name}…`);
    const result = await createTag(workspaceId, parsed.data, globalThis.crypto.randomUUID());
    markPending(temporaryId, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("Tag creation", result.kind, result.code));
      return;
    }
    setPage({ ...snapshot, items: [result.data.tag, ...snapshot.items] });
    setName("");
    setColor(TAG_DEFAULT_COLOR);
    setStatus(`Created ${result.data.tag.name}.`);
    await reconcile();
  }

  async function save(tag: TagSummary, nextName: string, nextColor: string): Promise<void> {
    const snapshot: TagPage = { ...page, items: [...page.items] };
    markPending(tag.id, true);
    setPage({
      ...page,
      items: page.items.map((item) =>
        item.id === tag.id ? { ...item, name: nextName, color: nextColor } : item,
      ),
    });
    setStatus(`Saving ${tag.name}…`);
    const result = await updateTag(workspaceId, tag.id, { name: nextName, color: nextColor });
    markPending(tag.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("Tag update", result.kind, result.code));
      return;
    }
    setPage({
      ...snapshot,
      items: snapshot.items.map((item) => (item.id === tag.id ? result.data.tag : item)),
    });
    setStatus(`Saved ${result.data.tag.name}.`);
    await reconcile();
  }

  async function remove(tag: TagSummary): Promise<void> {
    const snapshot: TagPage = { ...page, items: [...page.items] };
    markPending(tag.id, true);
    setPage({ ...page, items: page.items.filter((item) => item.id !== tag.id) });
    setStatus(`Deleting ${tag.name}…`);
    const result = await deleteTag(workspaceId, tag.id);
    markPending(tag.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("Tag deletion", result.kind, result.code));
      return;
    }
    setStatus(
      `Deleted ${tag.name}. It was removed from ${result.data.removedNoteAssignments} notes and ${result.data.removedTaskAssignments} tasks.`,
    );
    requestAnimationFrame(() => headingRef.current?.focus());
    await reconcile();
  }

  if (tagsQuery.isError) {
    return (
      <section className="rounded-xl border bg-card p-6" role="alert">
        <h1 className="text-2xl font-semibold">Tags unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The tag list could not be refreshed safely. No tag data was changed.
        </p>
        <Button className="mt-4" onClick={() => void reconcile()}>
          Retry
        </Button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 ref={headingRef} tabIndex={-1} className="text-3xl font-bold tracking-tight">
          Tags
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Tags are shared across the whole workspace. Each one shows how many notes and tasks use
          it.
        </p>
      </header>

      {canManage ? (
        <form onSubmit={(event) => void create(event)} className="space-y-4 rounded-xl border p-4">
          <h2 className="text-lg font-semibold">Create a tag</h2>
          <div className="flex flex-wrap items-start gap-3">
            <FormField
              id="create-tag-name"
              label="Tag name"
              value={name}
              required
              maxLength={50}
              autoComplete="off"
              disabled={operationPending}
              className="min-h-11 w-56"
              onChange={(event) => setName(event.target.value)}
            />
            <ColorField
              idPrefix="create-tag"
              swatchLabel="Tag colour"
              hexLabel="Tag colour hex"
              value={color}
              disabled={operationPending}
              onChange={setColor}
            />
            <Button type="submit" className="mt-7 min-h-11" disabled={operationPending}>
              Create tag
            </Button>
          </div>
        </form>
      ) : (
        <p className="rounded-md border bg-muted/30 p-3 text-sm" role="note">
          Your current role can browse these tags but cannot create, rename, or delete them. Backend
          authorization remains authoritative.
        </p>
      )}

      {canManage && !canDelete ? (
        <p className="rounded-md border bg-muted/30 p-3 text-sm" role="note">
          Deleting a tag requires an owner or admin, because it detaches the tag from every note and
          task at once.
        </p>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="min-h-6 text-sm text-muted-foreground"
      >
        {status}
      </div>

      {page.items.length === 0 ? (
        <section className="rounded-xl border border-dashed p-8 text-center">
          <h2 className="font-semibold">No tags yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {canManage
              ? "Create your first tag above to start grouping notes and tasks."
              : "Ask a workspace editor to create the first tag."}
          </p>
        </section>
      ) : (
        <ul aria-label="Workspace tags" className="space-y-3">
          {page.items.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              canManage={canManage}
              canDelete={canDelete}
              disabled={operationPending}
              onSave={save}
              onDelete={remove}
            />
          ))}
        </ul>
      )}

      {page.hasMore ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          This workspace has more than {page.limit} tags and the list is truncated. No omitted tag
          is deleted; narrow the workspace tag set or wait for tag pagination.
        </p>
      ) : null}
    </div>
  );
}
