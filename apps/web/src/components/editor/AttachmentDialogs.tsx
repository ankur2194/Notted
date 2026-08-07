"use client";

import { useCallback, useEffect, useState } from "react";

import { AttachmentDeleteDialog } from "./AttachmentDeleteDialog";
import { ATTACHMENT_EVENTS, ATTACHMENT_EXTENSION_NAME } from "./extensions/CustomAttachment";
import { PdfPreviewDialog } from "./PdfPreviewDialog";

import type { AttachmentDirectory } from "./attachment-directory";
import type { AttachmentEventDetail } from "./extensions/CustomAttachment";
import type { PdfjsLoader } from "@/lib/notes/pdf-preview";
import type { Editor } from "@tiptap/core";

import { attachmentContentUrl, deleteAttachment } from "@/lib/notes/attachment-requests";

export interface AttachmentDialogsProps {
  readonly editor: Editor | null;
  /** Always the workspace of the note being edited; never caller-derived. */
  readonly workspaceId: string;
  readonly editable: boolean;
  readonly attachmentDirectory?: AttachmentDirectory | null;
  /** Test seam, threaded through to the preview. */
  readonly loadPdfjs?: PdfjsLoader;
}

/**
 * React host for the two attachment dialogs (Part 44).
 *
 * ## Why the card raises an event instead of calling a callback
 *
 * The attachment node view is created by ProseMirror, not by React: there is no
 * component instance to thread a prop to, and the alternatives — a module-level
 * registry of open handlers, or a second injected resolver on the extension —
 * are both more coupling than a bubbling `CustomEvent` on an element this
 * component already has a reference to. `ATTACHMENT_EVENTS` names the two.
 *
 * Keeping the dialogs here rather than inside the node view is what preserves
 * the node view's `ignoreMutation: () => true` contract: no React state, no
 * portal, and no fetch lives inside the editor's own subtree.
 *
 * ## Deletion order
 *
 * The REST delete runs **first** and the node is removed only after the server
 * confirms — see `AttachmentDeleteDialog` for why the other order silently
 * orphans a file. Removal then happens through one ordinary editor transaction,
 * which reaches autosave by exactly the route a typed character takes. **No new
 * save call site is introduced**: this component never calls `updateNote`.
 */
export function AttachmentDialogs({
  editor,
  workspaceId,
  editable,
  attachmentDirectory,
  loadPdfjs,
}: AttachmentDialogsProps) {
  const [previewTarget, setPreviewTarget] = useState<AttachmentEventDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AttachmentEventDetail | null>(null);

  useEffect(() => {
    if (editor === null) return;
    const dom = editor.view.dom;

    const onPreview = (event: Event): void => {
      const detail = attachmentDetail(event);
      if (detail !== null) setPreviewTarget(detail);
    };
    const onRemove = (event: Event): void => {
      const detail = attachmentDetail(event);
      // A read-only reader never sees the control, and the server would refuse
      // the delete anyway; refusing here as well keeps the two agreeing.
      if (detail !== null && editable) setDeleteTarget(detail);
    };

    dom.addEventListener(ATTACHMENT_EVENTS.preview, onPreview);
    dom.addEventListener(ATTACHMENT_EVENTS.remove, onRemove);
    return () => {
      dom.removeEventListener(ATTACHMENT_EVENTS.preview, onPreview);
      dom.removeEventListener(ATTACHMENT_EVENTS.remove, onRemove);
    };
  }, [editor, editable]);

  // Close anything still open when the editor goes away, so a destroyed editor
  // can never be the target of a confirmed delete.
  useEffect(() => {
    if (editor !== null) return;
    setPreviewTarget(null);
    setDeleteTarget(null);
  }, [editor]);

  const urlFor = useCallback(
    (detail: AttachmentEventDetail | null): string | null => {
      if (detail === null) return null;
      // The directory's URL is preferred because it is the authorized
      // projection; the constructed one is the same route and exists only so a
      // preview still works before the listing lands.
      const resolved = attachmentDirectory?.resolve(detail.attachmentId);
      if (resolved?.kind === "ready") return resolved.entry.contentUrl;
      return attachmentContentUrl(workspaceId, detail.attachmentId);
    },
    [attachmentDirectory, workspaceId],
  );

  const handleConfirmDelete = useCallback(
    async (detail: AttachmentEventDetail): Promise<boolean> => {
      const result = await deleteAttachment(workspaceId, detail.attachmentId);
      if (!result.ok) return false;
      // Only now is the document touched. A failure above leaves the card, the
      // note, and the stored file exactly as they were.
      if (editor !== null && !editor.isDestroyed) {
        removeAttachmentNodes(editor, detail.attachmentId);
      }
      return true;
    },
    [editor, workspaceId],
  );

  return (
    <>
      <PdfPreviewDialog
        target={previewTarget}
        contentUrl={urlFor(previewTarget)}
        onOpenChange={(open) => {
          if (!open) setPreviewTarget(null);
        }}
        loadPdfjs={loadPdfjs}
      />
      <AttachmentDeleteDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}

/** Narrow an untrusted DOM event to the card's payload. Never throws. */
function attachmentDetail(event: Event): AttachmentEventDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const candidate = detail as Partial<AttachmentEventDetail>;
  if (typeof candidate.attachmentId !== "string" || candidate.attachmentId.length === 0) {
    return null;
  }
  return {
    attachmentId: candidate.attachmentId,
    name: typeof candidate.name === "string" ? candidate.name : "",
    mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : "",
    sizeBytes: typeof candidate.sizeBytes === "number" ? candidate.sizeBytes : 0,
    pos: typeof candidate.pos === "number" ? candidate.pos : null,
  };
}

/**
 * Remove **every** card referencing one attachment, in one transaction.
 *
 * By id rather than by the position the event carried, and that is deliberate on
 * two counts. The position is a snapshot taken when the button was clicked and
 * the writer may have edited above it while the confirmation was open, so it can
 * be stale. And the same file may legitimately be referenced twice in one note:
 * once the bytes are gone, *both* cards are dead, and leaving one behind would
 * show a permanent "unavailable" card the writer never chose to keep.
 *
 * Positions are collected first and deleted last-to-first, so each deletion
 * cannot invalidate the positions still to be applied.
 */
export function removeAttachmentNodes(editor: Editor, attachmentId: string): boolean {
  const positions: { from: number; to: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== ATTACHMENT_EXTENSION_NAME) return true;
    if (node.attrs.attachmentId !== attachmentId) return false;
    positions.push({ from: pos, to: pos + node.nodeSize });
    // An attachment is an atom; there is nothing inside it to descend into.
    return false;
  });
  if (positions.length === 0) return false;

  const tr = editor.state.tr;
  for (const range of positions.reverse()) tr.delete(range.from, range.to);
  editor.view.dispatch(tr);
  return true;
}
