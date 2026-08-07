"use client";

import {
  type UpdateWorkspaceInput,
  updateWorkspaceSchema,
  workspaceDeleteSchema,
} from "@notted/shared-validators";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { WorkspaceDetail, WorkspaceSettings } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { WorkspaceAvatar } from "@/components/workspaces/WorkspaceAvatar";
import { WorkspaceStorageLimit } from "@/components/workspaces/WorkspaceStorageLimit";
import { WorkspaceStorageUsagePanel } from "@/components/workspaces/WorkspaceStorageUsagePanel";
import { deleteWorkspace, updateWorkspace } from "@/lib/workspaces/requests";

type View = "edit" | "deleting";

/**
 * Workspace settings client island. Editing is gated by a server-derived
 * permission flag (`canManage` for settings.update = owner/admin; `canDelete`
 * for workspace.delete = owner). The backend re-authorizes every PATCH/DELETE;
 * these flags only decide which controls the UI presents. Billing is out of
 * scope and rendered as a clearly disabled placeholder.
 */
export function WorkspaceSettings({
  workspace,
  canManage,
  canDelete,
}: {
  readonly workspace: WorkspaceDetail;
  readonly canManage: boolean;
  readonly canDelete: boolean;
}) {
  const router = useRouter();
  const [persisted, setPersisted] = useState(workspace);
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [domain, setDomain] = useState(workspace.domain ?? "");
  const [defaultPageSize, setDefaultPageSize] = useState<WorkspaceSettings["defaultPageSize"]>(
    workspace.settings.defaultPageSize,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [view, setView] = useState<View>("edit");
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmationRef = useRef<HTMLInputElement>(null);
  const restoreDeleteFocusRef = useRef(false);

  useEffect(() => {
    if (view === "deleting") {
      deleteConfirmationRef.current?.focus();
      return;
    }
    if (restoreDeleteFocusRef.current) {
      restoreDeleteFocusRef.current = false;
      deleteTriggerRef.current?.focus();
    }
  }, [view]);

  // Build a minimal diff so unchanged fields (and an unchanged slug) are not
  // re-sent — this keeps the audit accurate and avoids spurious slug-collision
  // retries. Optional fields clear to `null` when emptied.
  function buildPatch(): UpdateWorkspaceInput {
    const patch: UpdateWorkspaceInput = {};
    if (name.trim() !== persisted.name) patch.name = name.trim();
    if (slug.trim() !== persisted.slug) patch.slug = slug.trim();
    const descriptionValue = description.trim().length === 0 ? null : description.trim();
    if (descriptionValue !== persisted.description) patch.description = descriptionValue;
    const domainValue = domain.trim().length === 0 ? null : domain.trim();
    if (domainValue !== persisted.domain) patch.domain = domainValue;
    if (defaultPageSize !== persisted.settings.defaultPageSize) {
      patch.settings = { defaultPageSize };
    }
    return patch;
  }

  function hasIdentityChanges(): boolean {
    const patch = buildPatch();
    return (
      patch.name !== undefined ||
      patch.slug !== undefined ||
      patch.description !== undefined ||
      patch.domain !== undefined
    );
  }

  function hasPageDefaultChanges(): boolean {
    return buildPatch().settings !== undefined;
  }

  function hasChanges(): boolean {
    return Object.keys(buildPatch()).length > 0;
  }

  function editFieldError(): string | null {
    if (!hasChanges()) return null;
    const parsed = updateWorkspaceSchema.safeParse(buildPatch());
    if (parsed.success) return null;
    const messages = parsed.error.issues.map((issue) => issue.message);
    return messages.length === 0 ? "Check the fields and try again." : messages.join(" ");
  }

  function canSave(): boolean {
    return canManage && !saving && hasChanges() && editFieldError() === null;
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage) return;
    const candidate = buildPatch();
    const parsed = updateWorkspaceSchema.safeParse(candidate);
    if (!parsed.success) {
      setSaveError(editFieldError() ?? "Check the fields and try again.");
      return;
    }
    setSavedAt(null);
    setSaving(true);
    setSaveError(null);
    const result = await updateWorkspace(workspace.id, parsed.data);
    setSaving(false);
    if (!result.ok) {
      setSaveError(
        result.kind === "forbidden"
          ? "You are not permitted to edit this workspace. Your access may have changed."
          : result.kind === "conflict"
            ? "That slug or domain is already in use. Choose another and try again."
            : result.kind === "invalid"
              ? "Those changes could not be validated. Adjust the fields and try again."
              : "The workspace could not be updated. Check your connection and try again.",
      );
      return;
    }
    const updated = result.data.workspace;
    setPersisted(updated);
    setName(updated.name);
    setSlug(updated.slug);
    setDescription(updated.description ?? "");
    setDomain(updated.domain ?? "");
    setDefaultPageSize(updated.settings.defaultPageSize);
    setSavedAt(new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date()));
    router.refresh();
  }

  function canConfirmDelete(): boolean {
    return canDelete && !deleting && confirmName === persisted.name;
  }

  async function handleDelete(): Promise<void> {
    if (!canDelete) return;
    if (confirmName !== persisted.name) {
      setDeleteError(`Type ${persisted.name} exactly to confirm deletion.`);
      return;
    }
    const confirmation = workspaceDeleteSchema.safeParse({
      confirm: true,
      expectedName: confirmName.trim(),
    });
    if (!confirmation.success) {
      setDeleteError("The confirmation was not accepted. Check the workspace name and try again.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    const result = await deleteWorkspace(workspace.id, confirmation.data);
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(
        result.kind === "forbidden"
          ? "Deletion was denied. Only the owner may delete this workspace."
          : result.kind === "conflict"
            ? "The workspace changed while deletion was being confirmed. Review the name and try again."
            : result.kind === "invalid"
              ? "The confirmation was not accepted. Try again."
              : "The workspace could not be deleted. Check your connection and try again.",
      );
      return;
    }
    // Replace the destructive route so Back does not reopen a now-deleted
    // settings URL; refresh then rebuilds the shell without the membership.
    router.replace("/workspaces");
    router.refresh();
  }

  const fieldError = editFieldError();

  return (
    <div className="space-y-8">
      {saveError !== null ? <ErrorSummary message={saveError} /> : null}
      {savedAt !== null ? <FormStatus>Settings saved at {savedAt}.</FormStatus> : null}

      <section
        className="space-y-4 rounded-xl border border-border p-5"
        aria-labelledby="workspace-identity-title"
      >
        <div>
          <h2 id="workspace-identity-title" className="text-xl font-semibold">
            Identity
          </h2>
          <p className="text-sm text-muted-foreground">
            Rename the workspace and adjust its slug, description, and domain.
          </p>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/20 p-4 sm:flex-row sm:items-center">
          <WorkspaceAvatar name={persisted.name} logoUrl={persisted.logoUrl} size="lg" />
          <div className="flex-1">
            <p className="font-medium">Workspace logo</p>
            <p className="text-sm text-muted-foreground">
              Logo upload is not available in this build. The initials placeholder is used when no
              public logo is configured.
            </p>
          </div>
          <Button type="button" variant="outline" disabled aria-disabled="true">
            Replace logo
          </Button>
        </div>
        {!canManage ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm" role="note">
            You need owner or admin access to edit workspace identity. Your role is{" "}
            <span className="font-medium capitalize">{persisted.currentUserRole}</span>.
          </p>
        ) : null}
        <form
          className="space-y-4"
          onSubmit={(event) => void handleSave(event)}
          noValidate
          aria-busy={saving}
        >
          <FormField
            id="settings-name"
            name="name"
            label="Workspace name"
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setSavedAt(null);
            }}
            disabled={!canManage || saving}
            required
            maxLength={255}
          />
          <FormField
            id="settings-slug"
            name="slug"
            label="Slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.currentTarget.value);
              setSavedAt(null);
            }}
            disabled={!canManage || saving}
            required
            maxLength={63}
            hint="Changing the slug updates the handle others use to reference this workspace."
          />
          <FormField
            id="settings-description"
            name="description"
            label="Description (optional)"
            value={description}
            onChange={(event) => {
              setDescription(event.currentTarget.value);
              setSavedAt(null);
            }}
            disabled={!canManage || saving}
            maxLength={2000}
          />
          <FormField
            id="settings-domain"
            name="domain"
            label="Custom domain (optional)"
            value={domain}
            onChange={(event) => {
              setDomain(event.currentTarget.value);
              setSavedAt(null);
            }}
            disabled={!canManage || saving}
            placeholder="workspace.example.com"
            maxLength={253}
            hint="Domain verification is not available in this build. Saving this value does not verify or activate the domain."
          />
          {fieldError !== null && canManage && hasChanges() ? (
            <p className="text-sm text-destructive" role="status">
              {fieldError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canSave() || !hasIdentityChanges()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!canManage || saving || !hasIdentityChanges()}
              onClick={() => {
                setName(persisted.name);
                setSlug(persisted.slug);
                setDescription(persisted.description ?? "");
                setDomain(persisted.domain ?? "");
                setSaveError(null);
                setSavedAt(null);
              }}
            >
              Discard changes
            </Button>
          </div>
        </form>
      </section>

      <section
        className="space-y-4 rounded-xl border border-border p-5"
        aria-labelledby="workspace-page-defaults-title"
      >
        <div>
          <h2 id="workspace-page-defaults-title" className="text-xl font-semibold">
            Page defaults
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose the paper size used when a new note does not specify its own size.
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => void handleSave(event)}
          noValidate
          aria-busy={saving}
        >
          <div className="space-y-2">
            <label htmlFor="settings-default-page-size" className="text-sm font-medium">
              Default page size
            </label>
            <select
              id="settings-default-page-size"
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              value={defaultPageSize}
              disabled={!canManage || saving}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "a4" || value === "letter") {
                  setDefaultPageSize(value);
                  setSavedAt(null);
                }
              }}
            >
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={!canSave() || !hasPageDefaultChanges()}>
              {saving ? "Saving…" : "Save page default"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!canManage || saving || !hasPageDefaultChanges()}
              onClick={() => {
                setDefaultPageSize(persisted.settings.defaultPageSize);
                setSaveError(null);
                setSavedAt(null);
              }}
            >
              Discard page default
            </Button>
          </div>
        </form>
        {!canManage ? (
          <p className="text-sm text-muted-foreground" role="note">
            Default page size is read-only for your role. Owners and admins can change it.
          </p>
        ) : null}
        <div className="space-y-4 rounded-md border bg-muted/20 p-4">
          {/*
           * The storage block sits inside the "Page defaults" section, where
           * Part 26 put the limit override. It now carries enough content to
           * need its own heading, so a screen-reader user is not left hearing
           * quota figures announced under a page-size heading.
           */}
          <h3 className="text-sm font-semibold">Storage</h3>
          <dl className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <dt className="text-muted-foreground">Storage limit override</dt>
            <dd className="font-medium">
              <WorkspaceStorageLimit bytes={persisted.storageLimitBytes} />
            </dd>
          </dl>
          {/*
           * Part 45. Usage is readable by every role (`settings.read`), so this
           * renders regardless of `canManage` — a viewer who cannot change the
           * limit still needs to know how close the workspace is to it. The
           * limit itself remains read-only here; only the numbers are new.
           */}
          <WorkspaceStorageUsagePanel workspaceId={persisted.id} />
          <p className="text-sm text-muted-foreground">
            The limit is read-only here. Usage is measured by the server and is never estimated in
            the browser.
          </p>
        </div>
      </section>

      <section
        className="space-y-4 rounded-xl border border-border p-5"
        aria-labelledby="workspace-billing-title"
      >
        <div>
          <h2 id="workspace-billing-title" className="text-xl font-semibold">
            Plan &amp; billing
          </h2>
          <p className="text-sm text-muted-foreground">
            Current plan:{" "}
            <span className="font-medium capitalize text-foreground">{persisted.plan}</span>
          </p>
        </div>
        <div
          className="space-y-2 rounded-md border border-dashed border-border bg-muted/30 p-4"
          role="note"
          aria-live="polite"
        >
          <p className="text-sm text-muted-foreground">Billing is not available in this build.</p>
          <p className="text-sm text-muted-foreground">
            Plan changes, invoices, and usage limits are not managed here. Upgrading or downgrading
            is handled outside Notted.
          </p>
          {persisted.currentUserRole !== "owner" ? (
            <p className="text-sm text-muted-foreground">
              Only workspace owners can view billing details when billing becomes available.
            </p>
          ) : null}
          <Button type="button" disabled aria-disabled="true">
            Manage billing
          </Button>
        </div>
      </section>

      <section
        className="space-y-4 rounded-xl border border-destructive p-5"
        aria-labelledby="workspace-danger-title"
      >
        <div>
          <h2 id="workspace-danger-title" className="text-xl font-semibold text-destructive">
            Danger zone
          </h2>
          <p className="text-sm text-muted-foreground">
            Deleting a workspace permanently removes its projects, notes, and members. This cannot
            be undone.
          </p>
        </div>
        {!canDelete ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm" role="note">
            Only the workspace owner may delete this workspace. Your role is{" "}
            <span className="font-medium capitalize">{persisted.currentUserRole}</span>.
          </p>
        ) : view === "edit" ? (
          <Button
            ref={deleteTriggerRef}
            type="button"
            variant="destructive"
            onClick={() => setView("deleting")}
          >
            Delete workspace
          </Button>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleDelete();
            }}
          >
            <FormField
              ref={deleteConfirmationRef}
              id="delete-confirm-name"
              name="confirmName"
              label={`Type the workspace name (${persisted.name}) to confirm`}
              value={confirmName}
              onChange={(event) => setConfirmName(event.currentTarget.value)}
              disabled={deleting}
              required
              autoComplete="off"
            />
            {deleteError !== null ? <ErrorSummary message={deleteError} /> : null}
            {deleting ? <FormStatus>Deleting workspace…</FormStatus> : null}
            <div className="flex gap-3">
              <Button type="submit" variant="destructive" disabled={!canConfirmDelete()}>
                {deleting ? "Deleting…" : "Permanently delete"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={deleting}
                onClick={() => {
                  restoreDeleteFocusRef.current = true;
                  setView("edit");
                  setConfirmName("");
                  setDeleteError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
