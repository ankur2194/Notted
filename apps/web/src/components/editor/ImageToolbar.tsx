"use client";

import {
  NOTE_DOCUMENT_IMAGE_ALIGNMENTS,
  noteDocumentImageAttrs,
  type NoteDocumentImageAlign,
} from "@notted/shared-validators";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IMAGE_EXTENSION_NAME, updateSelectedImage } from "./extensions/CustomImage";
import { ImageAltTextDialog } from "./ImageAltTextDialog";
import { useRovingToolbar } from "./useRovingToolbar";
import { useSelectedNode } from "./useSelectedNode";

import type { ImageAttributePatch } from "./extensions/CustomImage";
import type { Editor } from "@tiptap/core";

import { cn } from "@/lib/utils";

export const IMAGE_TOOLBAR_LABEL = "Image options";
/** Gap between the bottom of the figure and the toolbar, in CSS pixels. */
const TOOLBAR_OFFSET_PX = 8;
/** Keeps the toolbar off the very edge of the viewport at any zoom. */
const VIEWPORT_MARGIN_PX = 12;

const ALIGN_LABELS: Readonly<Record<NoteDocumentImageAlign, string>> = {
  left: "Align image left",
  center: "Align image center",
  right: "Align image right",
};

/** Visible caps. The accessible name is the fuller `ALIGN_LABELS` entry. */
const ALIGN_CAPTIONS: Readonly<Record<NoteDocumentImageAlign, string>> = {
  left: "Left",
  center: "Center",
  right: "Right",
};

interface ToolbarButtonProps {
  readonly id: string;
  readonly label: string;
  readonly pressed?: boolean;
  readonly tabIndex: 0 | -1;
  readonly onFocus: () => void;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function ToolbarButton({
  id,
  label,
  pressed,
  tabIndex,
  onFocus,
  onClick,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      data-toolbar-item={id}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onClick}
      className={cn(
        "rounded-md border border-transparent px-2 py-1 text-xs font-medium",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        pressed === true && "border-border bg-accent text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

export interface ImageToolbarProps {
  readonly editor: Editor | null;
  readonly editable: boolean;
  /** Resolved after mount by the host; `null` during the server render. */
  readonly portalTarget: HTMLElement | null;
}

/**
 * Contextual controls for the selected image: alignment, wrap mode, full width,
 * alternative text, and removal.
 *
 * ## Why it is portalled to `document.body`
 *
 * `PageContainer`'s paper always carries `transform: translateX(-50%) scale(z)`,
 * and a transformed ancestor becomes the containing block for every
 * `position: fixed` descendant. A toolbar rendered inside the editor subtree
 * would therefore be positioned against — and *scaled with* — the sheet. The
 * focus-mode toolbar in `TiptapEditor.tsx` established the fix and this reuses
 * it: render into `document.body`, position from the node's viewport rect, and
 * divide nothing by the zoom (both the rect and `position: fixed` are already in
 * scaled viewport space; Part 42, Decision 7).
 *
 * ## Why plain buttons
 *
 * There is no `popover`, `tooltip`, or `dropdown-menu` primitive in
 * `components/ui`, and Part 42 declined to add a Radix dependency for one
 * widget. Native `<button>` elements in a `role="toolbar"` with a roving tab
 * index are the APG pattern anyway, and `useRovingToolbar` already implements
 * it for `EditorToolbar`.
 */
export function ImageToolbar({ editor, editable, portalTarget }: ImageToolbarProps) {
  const selected = useSelectedNode(editor, IMAGE_EXTENSION_NAME);
  const [dismissed, setDismissed] = useState(false);
  const [altOpen, setAltOpen] = useState(false);

  const position = selected?.pos ?? null;
  // Escape hides the toolbar for the image it was dismissed on; selecting a
  // different image (or reselecting this one) brings it back.
  useEffect(() => {
    setDismissed(false);
    setAltOpen(false);
  }, [position]);

  const itemIds = useMemo(
    () => [
      ...NOTE_DOCUMENT_IMAGE_ALIGNMENTS.map((align) => `align-${align}`),
      "wrap-block",
      "wrap-inline",
      "full-width",
      "alt-text",
      "remove",
    ],
    [],
  );
  const { toolbarRef, tabIndexFor, onItemFocus, onKeyDown } = useRovingToolbar(itemIds);

  const attrs = selected === null ? null : noteDocumentImageAttrs(selected.node.attrs);
  if (
    editor === null ||
    !editable ||
    selected === null ||
    attrs === null ||
    dismissed ||
    portalTarget === null
  ) {
    return null;
  }

  const apply = (patch: ImageAttributePatch): void => {
    updateSelectedImage(editor, patch);
  };

  const returnFocus = (): void => {
    editor.commands.focus();
  };

  const rect = selected.rect;
  const top = (rect?.bottom ?? 0) + TOOLBAR_OFFSET_PX;
  const left = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;

  const toolbar = (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={IMAGE_TOOLBAR_LABEL}
      aria-orientation="horizontal"
      data-notted-print-hide
      data-testid="note-image-toolbar"
      onKeyDown={(event) => {
        if (event.key !== "Escape") {
          // Arrow/Home/End roving navigation; every other key falls through.
          onKeyDown(event);
          return;
        }
        event.preventDefault();
        setDismissed(true);
        // The image stays selected, so returning focus to the editor leaves the
        // author exactly where they were rather than at `document.body`.
        returnFocus();
      }}
      style={{
        position: "fixed",
        top: `${Math.max(VIEWPORT_MARGIN_PX, top)}px`,
        left: `${Math.max(VIEWPORT_MARGIN_PX, left)}px`,
        transform: "translateX(-50%)",
      }}
      className="z-50 flex flex-wrap items-center gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {NOTE_DOCUMENT_IMAGE_ALIGNMENTS.map((align) => (
        <ToolbarButton
          key={align}
          id={`align-${align}`}
          label={ALIGN_LABELS[align]}
          pressed={attrs.align === align}
          tabIndex={tabIndexFor(`align-${align}`)}
          onFocus={() => onItemFocus(`align-${align}`)}
          onClick={() => apply({ align })}
        >
          {ALIGN_CAPTIONS[align]}
        </ToolbarButton>
      ))}
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
      <ToolbarButton
        id="wrap-block"
        label="Break text around the image"
        pressed={attrs.wrap === "block" && !attrs.fullWidth}
        tabIndex={tabIndexFor("wrap-block")}
        onFocus={() => onItemFocus("wrap-block")}
        onClick={() => apply({ wrap: "block" })}
      >
        Break text
      </ToolbarButton>
      <ToolbarButton
        id="wrap-inline"
        label="Wrap text beside the image"
        pressed={attrs.wrap === "inline" && !attrs.fullWidth}
        tabIndex={tabIndexFor("wrap-inline")}
        onFocus={() => onItemFocus("wrap-inline")}
        // A floated figure cannot also span the whole column, so the two are
        // written together in one transaction: the document is never left in the
        // ambiguous state `resolveNoteImageWrap` exists to resolve on read.
        onClick={() => apply({ wrap: "inline", fullWidth: false })}
      >
        Wrap text
      </ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
      <ToolbarButton
        id="full-width"
        label="Full width image"
        pressed={attrs.fullWidth}
        tabIndex={tabIndexFor("full-width")}
        onFocus={() => onItemFocus("full-width")}
        onClick={() =>
          apply(
            attrs.fullWidth ? { fullWidth: false } : { fullWidth: true, wrap: "block" as const },
          )
        }
      >
        Full width
      </ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
      <ToolbarButton
        id="alt-text"
        label="Edit image alternative text"
        tabIndex={tabIndexFor("alt-text")}
        onFocus={() => onItemFocus("alt-text")}
        onClick={() => setAltOpen(true)}
      >
        Alt text…
      </ToolbarButton>
      <ToolbarButton
        id="remove"
        label="Remove image"
        tabIndex={tabIndexFor("remove")}
        onFocus={() => onItemFocus("remove")}
        onClick={() => {
          // The attachment row is deliberately left alone: reconciling orphaned
          // objects is Part 45's job, and deleting storage from an undoable
          // editor action would destroy bytes a single Ctrl+Z should restore.
          editor.chain().deleteSelection().focus().run();
        }}
      >
        Remove
      </ToolbarButton>
    </div>
  );

  return (
    <>
      {createPortal(toolbar, portalTarget)}
      <ImageAltTextDialog
        open={altOpen}
        onOpenChange={setAltOpen}
        initialAlt={attrs.alt}
        onApply={(alt) => {
          // Validated with the shared contract itself rather than with a second,
          // drifting copy of its rules: if the resulting attributes would not
          // parse, the value never reaches the document.
          if (noteDocumentImageAttrs({ ...selected.node.attrs, alt }) === null) return false;
          apply({ alt });
          return true;
        }}
      />
    </>
  );
}
