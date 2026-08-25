"use client";

import {
  ACCENT_CONTRAST_MIN_RATIO,
  ACCENT_CONTRAST_TARGET_RATIO,
  accentContrast,
  type UpdateWorkspaceInput,
  updateWorkspaceSchema,
  workspaceDeleteSchema,
} from "@notted/shared-validators";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { WorkspaceDetail, WorkspaceSettings } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { CustomDomainSettings } from "@/components/workspaces/CustomDomainSettings";
import { WorkspaceAvatar } from "@/components/workspaces/WorkspaceAvatar";
import { WorkspaceStorageLimit } from "@/components/workspaces/WorkspaceStorageLimit";
import { WorkspaceStorageUsagePanel } from "@/components/workspaces/WorkspaceStorageUsagePanel";
import {
  WORKSPACE_LOGO_MAX_BYTES,
  deleteWorkspace,
  deleteWorkspaceLogo,
  updateWorkspace,
  uploadWorkspaceLogo,
} from "@/lib/workspaces/requests";

type View = "edit" | "deleting";

/** Matches what the API sniffs and `ImageProcessingService` can re-encode. */
const LOGO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/heic";

/** The platform accent, used as the colour-input value when none is chosen. */
const DEFAULT_ACCENT_COLOR = "#2563eb";

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
  const [defaultPageSize, setDefaultPageSize] = useState<WorkspaceSettings["defaultPageSize"]>(
    workspace.settings.defaultPageSize,
  );
  const [accentColor, setAccentColor] = useState<string | null>(
    workspace.settings.accentColor ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

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
    const persistedAccent = persisted.settings.accentColor ?? null;
    if (defaultPageSize !== persisted.settings.defaultPageSize || accentColor !== persistedAccent) {
      // `settings` is sent whole because the API merges a validated object over
      // the stored one; `accentColor: null` is the explicit "use the platform
      // default" instruction and is NOT the same as omitting the key.
      patch.settings = { defaultPageSize, accentColor };
    }
    return patch;
  }

  function hasIdentityChanges(): boolean {
    const patch = buildPatch();
    return patch.name !== undefined || patch.slug !== undefined || patch.description !== undefined;
  }

  function hasPageDefaultChanges(): boolean {
    return defaultPageSize !== persisted.settings.defaultPageSize;
  }

  function hasAccentChanges(): boolean {
    return accentColor !== (persisted.settings.accentColor ?? null);
  }

  /**
   * The SAME function the API refuses with, so the number shown here and the
   * number the server measured can never disagree. `fail` blocks the save
   * locally too — not as the control (the API is), but so the reader is told
   * before a round-trip rather than by a 422.
   */
  function contrast() {
    return accentColor === null ? null : accentContrast(accentColor);
  }

  function accentBlocksSave(): boolean {
    const measured = contrast();
    return measured === null ? accentColor !== null : measured.level === "fail";
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
    return canManage && !saving && hasChanges() && editFieldError() === null && !accentBlocksSave();
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
            ? "That slug is already in use. Choose another and try again."
            : result.kind === "invalid"
              ? // 422 also carries `ACCENT_CONTRAST_TOO_LOW`; the accent readout
                // below already names that remedy, so this stays generic.
                "Those changes could not be validated. Adjust the fields and try again."
              : "The workspace could not be updated. Check your connection and try again.",
      );
      return;
    }
    const updated = result.data.workspace;
    setPersisted(updated);
    setName(updated.name);
    setSlug(updated.slug);
    setDescription(updated.description ?? "");
    setDefaultPageSize(updated.settings.defaultPageSize);
    setAccentColor(updated.settings.accentColor ?? null);
    setSavedAt(new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date()));
    router.refresh();
  }

  /**
   * Logo upload. Deliberately NOT part of the settings form: it is multipart,
   * it has its own route and its own audit action, and it must not be able to
   * fail (or succeed) a name change alongside it.
   *
   * The persisted path is re-read from the server response — no `URL.createObjectURL`
   * preview is ever stored, because a blob URL dies with the page and would
   * leave a broken image behind if it were persisted anywhere.
   */
  async function handleLogoUpload(file: File): Promise<void> {
    if (!canManage) return;
    if (file.size > WORKSPACE_LOGO_MAX_BYTES) {
      setLogoError("That image is larger than 2 MB. Choose a smaller file.");
      return;
    }
    setLogoBusy(true);
    setLogoError(null);
    const result = await uploadWorkspaceLogo(workspace.id, file);
    setLogoBusy(false);
    if (logoInputRef.current !== null) logoInputRef.current.value = "";
    if (!result.ok) {
      setLogoError(
        result.kind === "forbidden"
          ? "You are not permitted to change this workspace's logo."
          : result.kind === "invalid"
            ? "That file could not be used as a logo. Use a PNG, JPEG, GIF, WebP, SVG, or HEIC image under 2 MB."
            : "The logo could not be uploaded. Check your connection and try again.",
      );
      return;
    }
    setPersisted({ ...persisted, logoUrl: result.data.logoUrl });
    router.refresh();
  }

  async function handleLogoRemove(): Promise<void> {
    if (!canManage) return;
    setLogoBusy(true);
    setLogoError(null);
    const result = await deleteWorkspaceLogo(workspace.id);
    setLogoBusy(false);
    if (!result.ok) {
      setLogoError(
        result.kind === "forbidden"
          ? "You are not permitted to change this workspace's logo."
          : "The logo could not be removed. Check your connection and try again.",
      );
      return;
    }
    setPersisted({ ...persisted, logoUrl: null });
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
            Rename the workspace and adjust its slug and description.
          </p>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/20 p-4 sm:flex-row sm:items-center">
          <WorkspaceAvatar name={persisted.name} logoUrl={persisted.logoUrl} size="lg" />
          <div className="flex-1 space-y-2">
            <label htmlFor="settings-logo" className="block font-medium">
              Workspace logo
            </label>
            <p id="settings-logo-hint" className="text-sm text-muted-foreground">
              PNG, JPEG, GIF, WebP, SVG, or HEIC, up to 2 MB. The image is converted to a small WebP
              and published at a public but unguessable address so it can also be shown in email.
              The initials placeholder is used when no logo is set.
            </p>
            <input
              ref={logoInputRef}
              id="settings-logo"
              type="file"
              accept={LOGO_ACCEPT}
              aria-describedby="settings-logo-hint"
              disabled={!canManage || logoBusy}
              className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) void handleLogoUpload(file);
              }}
            />
            {logoError !== null ? <ErrorSummary message={logoError} /> : null}
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              {logoBusy
                ? "Updating the logo…"
                : persisted.logoUrl === null
                  ? "No logo is set."
                  : "A logo is set."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!canManage || logoBusy || persisted.logoUrl === null}
            onClick={() => void handleLogoRemove()}
          >
            Remove logo
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
        aria-labelledby="workspace-appearance-title"
      >
        <div>
          <h2 id="workspace-appearance-title" className="text-xl font-semibold">
            Appearance
          </h2>
          <p className="text-sm text-muted-foreground">
            The accent color tints buttons, links, and focus rings across this workspace, and
            headers in email sent from it.
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => void handleSave(event)}
          noValidate
          aria-busy={saving}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <label htmlFor="settings-accent-color" className="block text-sm font-medium">
                Accent color
              </label>
              {/*
                A native `<input type="color">` rather than a picker component:
                it is keyboard accessible and screen-reader labelled by the
                platform, and it is the control users already know. The text
                field beside it is what makes an exact brand hex typeable — and
                what makes the value copyable, which a swatch alone is not.
              */}
              <input
                id="settings-accent-color"
                type="color"
                value={accentColor ?? DEFAULT_ACCENT_COLOR}
                disabled={!canManage || saving}
                aria-describedby="settings-accent-contrast"
                className="h-11 w-16 cursor-pointer rounded-md border border-input bg-background p-1 disabled:cursor-not-allowed disabled:opacity-50"
                onChange={(event) => {
                  setAccentColor(event.currentTarget.value.toLowerCase());
                  setSavedAt(null);
                }}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="settings-accent-hex" className="block text-sm font-medium">
                Hex value
              </label>
              <input
                id="settings-accent-hex"
                name="accentColorHex"
                type="text"
                inputMode="text"
                spellCheck={false}
                autoComplete="off"
                maxLength={7}
                placeholder={DEFAULT_ACCENT_COLOR}
                value={accentColor ?? ""}
                disabled={!canManage || saving}
                aria-describedby="settings-accent-contrast"
                className="min-h-11 w-32 rounded-md border border-input bg-background px-3 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-50"
                onChange={(event) => {
                  const value = event.currentTarget.value.trim().toLowerCase();
                  setAccentColor(value === "" ? null : value);
                  setSavedAt(null);
                }}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!canManage || saving || accentColor === null}
              onClick={() => {
                setAccentColor(null);
                setSavedAt(null);
              }}
            >
              Use default
            </Button>
          </div>
          {/*
            Announced politely, not asserted: it updates on every keystroke of
            the hex field and every drag of the colour input, and an assertive
            region would interrupt the person typing.
          */}
          <p
            id="settings-accent-contrast"
            role="status"
            aria-live="polite"
            className={
              accentBlocksSave() ? "text-sm text-destructive" : "text-sm text-muted-foreground"
            }
          >
            {accentColor === null
              ? `No accent color is set. The platform default (${DEFAULT_ACCENT_COLOR}) is used.`
              : contrast() === null
                ? "Enter a six-digit hex color, for example #2563eb."
                : contrast()?.level === "fail"
                  ? `Contrast ${String(contrast()?.ratioOnWhite)}:1 against white is too low to save. Choose a darker shade with at least ${String(ACCENT_CONTRAST_MIN_RATIO)}:1.`
                  : contrast()?.level === "warn"
                    ? `Contrast ${String(contrast()?.ratioOnWhite)}:1 against white. This is readable for buttons and borders but below the ${String(ACCENT_CONTRAST_TARGET_RATIO)}:1 needed for body text.`
                    : `Contrast ${String(contrast()?.ratioOnWhite)}:1 against white. This passes WCAG AA for text and non-text alike.`}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={!canSave() || !hasAccentChanges()}>
              {saving ? "Saving…" : "Save accent color"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!canManage || saving || !hasAccentChanges()}
              onClick={() => {
                setAccentColor(persisted.settings.accentColor ?? null);
                setSaveError(null);
                setSavedAt(null);
              }}
            >
              Discard accent color
            </Button>
          </div>
        </form>
        {!canManage ? (
          <p className="text-sm text-muted-foreground" role="note">
            The accent color is read-only for your role. Owners and admins can change it.
          </p>
        ) : null}
      </section>

      {/*
       * Part 73. Its own section, and only for someone who can act on it: the
       * routes behind it are `settings.update`, so a viewer would be shown four
       * controls that can only ever answer 403.
       */}
      {canManage ? <CustomDomainSettings workspaceId={workspace.id} /> : null}

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
