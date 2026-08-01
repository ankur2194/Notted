"use client";

import { createWorkspaceSchema } from "@notted/shared-validators";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { WorkspaceSettings } from "@notted/shared-types";

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
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { selectWorkspace } from "@/lib/shell/requests";
import { createWorkspace, suggestSlugFromName } from "@/lib/workspaces/requests";

interface CreatedState {
  readonly workspaceId: string;
  readonly slug: string;
}

interface PendingIdempotency {
  readonly fingerprint: string;
  readonly key: string;
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Create-workspace client island. The body is validated client-side with the
 * shared `createWorkspaceSchema`; trusted-origin is enforced by the API. The
 * slug auto-suggests from the name until the user edits it manually. On
 * success the dialog shows the FINAL (collision-resolved) slug returned by the
 * API, then selects the new workspace as current via the shared cookie helper
 * and navigates to its overview with a refresh so the shell updates
 * immediately.
 */
export function CreateWorkspaceDialog({
  triggerLabel = "Create workspace",
}: {
  readonly triggerLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [defaultPageSize, setDefaultPageSize] =
    useState<WorkspaceSettings["defaultPageSize"]>("a4");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedState | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const pendingIdempotency = useRef<PendingIdempotency | null>(null);

  // Reset the form whenever the dialog is closed so a reopen is always clean.
  useEffect(() => {
    if (open) return;
    setName("");
    setSlug("");
    setSlugTouched(false);
    setDescription("");
    setDefaultPageSize("a4");
    setError(null);
    setCreated(null);
    setSubmitting(false);
    setSelecting(false);
    setSelectionError(null);
    pendingIdempotency.current = null;
  }, [open]);

  function handleNameChange(value: string): void {
    setName(value);
    if (!slugTouched) setSlug(suggestSlugFromName(value));
  }

  function handleSlugChange(value: string): void {
    setSlugTouched(true);
    setSlug(value);
  }

  function handleOpenChange(nextOpen: boolean): void {
    // Keep the client island mounted while either mutation is in flight. This
    // prevents an Escape/overlay close from losing the committed result or
    // continuing navigation from a reset dialog.
    if (!nextOpen && (submitting || selecting)) return;
    setOpen(nextOpen);
  }

  function friendlyError(): string {
    if (error !== null) return error;
    const parsed = createWorkspaceSchema.safeParse({
      name: name.trim(),
      slug: slug.trim(),
      description: description.trim().length === 0 ? null : description.trim(),
      settings: { defaultPageSize },
    });
    if (parsed.success) return "";
    const messages = parsed.error.issues.map((issue) => issue.message);
    return messages.length === 0
      ? "Check the workspace details and try again."
      : messages.join(" ");
  }

  function canSubmit(): boolean {
    if (submitting || created !== null) return false;
    const parsed = createWorkspaceSchema.safeParse({
      name: name.trim(),
      slug: slug.trim(),
      description: description.trim().length === 0 ? null : description.trim(),
      settings: { defaultPageSize },
    });
    return parsed.success;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const trimmed = {
      name: name.trim(),
      slug: slug.trim(),
      description: description.trim().length === 0 ? null : description.trim(),
      settings: { defaultPageSize },
    };
    const parsed = createWorkspaceSchema.safeParse(trimmed);
    if (!parsed.success) {
      setError(friendlyError());
      return;
    }
    setSubmitting(true);
    const fingerprint = JSON.stringify(parsed.data);
    if (pendingIdempotency.current?.fingerprint !== fingerprint) {
      pendingIdempotency.current = { fingerprint, key: newIdempotencyKey() };
    }
    const result = await createWorkspace(parsed.data, pendingIdempotency.current.key);
    if (!result.ok) {
      setSubmitting(false);
      setError(
        result.kind === "forbidden"
          ? "You are not permitted to create a workspace, or the details were rejected."
          : result.kind === "conflict"
            ? "That workspace slug or domain is already in use. Choose another and try again."
            : result.kind === "invalid"
              ? "Those details could not be validated. Adjust the name or slug and try again."
              : "The workspace could not be created. Check your connection and try again.",
      );
      return;
    }
    const { workspace, slug: finalSlug } = result.data;
    // Surface the FINAL slug (may include a collision suffix) before leaving.
    const createdWorkspace = { workspaceId: workspace.id, slug: finalSlug };
    setCreated(createdWorkspace);
    setSubmitting(false);
    await selectAndOpen(createdWorkspace);
  }

  async function selectAndOpen(createdWorkspace: CreatedState): Promise<void> {
    setSelecting(true);
    setSelectionError(null);
    const selection = await selectWorkspace(createdWorkspace.workspaceId);
    setSelecting(false);
    if (!selection.ok) {
      setSelectionError(
        "The workspace was created, but it could not be made current. Retry to finish opening it.",
      );
      // The create mutation already committed. Refresh the list/shell cache even
      // though selection failed so closing the dialog never hides the new row.
      router.refresh();
      return;
    }
    router.push(`/workspaces/${createdWorkspace.workspaceId}`);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
          <DialogDescription>
            Workspaces isolate your projects, notes, and members. You become the owner of the one
            you create.
          </DialogDescription>
        </DialogHeader>
        {created !== null ? (
          <div className="space-y-3">
            <p className="font-medium">Workspace created.</p>
            <p className="text-sm text-muted-foreground">
              Final handle: <span className="font-mono text-foreground">{created.slug}</span>
            </p>
            {selectionError === null ? (
              <FormStatus>
                {selecting ? "Making this your current workspace…" : "Opening your new workspace…"}
              </FormStatus>
            ) : (
              <>
                <ErrorSummary message={selectionError} />
                <Button
                  type="button"
                  disabled={selecting}
                  onClick={() => void selectAndOpen(created)}
                >
                  {selecting ? "Retrying…" : "Retry and open workspace"}
                </Button>
              </>
            )}
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
            <FormField
              id="workspace-name"
              name="name"
              label="Workspace name"
              value={name}
              onChange={(event) => handleNameChange(event.currentTarget.value)}
              placeholder="Acme Design"
              disabled={submitting}
              required
              maxLength={255}
              autoComplete="organization"
            />
            <FormField
              id="workspace-slug"
              name="slug"
              label="Workspace slug"
              value={slug}
              onChange={(event) => handleSlugChange(event.currentTarget.value)}
              placeholder="acme-design"
              disabled={submitting}
              required
              maxLength={63}
              inputMode="text"
              hint="Lower-case letters, numbers, and single hyphens. A suffix is added automatically if the slug is taken."
            />
            <FormField
              id="workspace-description"
              name="description"
              label="Description (optional)"
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="What is this workspace for?"
              disabled={submitting}
              maxLength={2000}
            />
            <div className="space-y-2">
              <label htmlFor="workspace-default-page-size" className="text-sm font-medium">
                Default page size
              </label>
              <select
                id="workspace-default-page-size"
                className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                value={defaultPageSize}
                disabled={submitting}
                aria-describedby="workspace-default-page-size-hint"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === "a4" || value === "letter") setDefaultPageSize(value);
                }}
              >
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
              <p id="workspace-default-page-size-hint" className="text-sm text-muted-foreground">
                New notes use this paper size unless someone chooses another size for the note.
              </p>
            </div>
            {error !== null ? <ErrorSummary message={error} /> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={submitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit()}>
                {submitting ? "Creating…" : "Create workspace"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
