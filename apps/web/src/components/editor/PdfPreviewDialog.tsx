"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "./reduced-motion";
import { useDialogFocusRestore } from "./useDialogFocusRestore";

import type { AttachmentEventDetail } from "./extensions/CustomAttachment";
import type { PdfPreviewDocument, PdfjsLoader } from "@/lib/notes/pdf-preview";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openPdfPreview } from "@/lib/notes/pdf-preview";

export interface PdfPreviewDialogProps {
  /** The card that asked for a preview, or `null` when the dialog is closed. */
  readonly target: AttachmentEventDetail | null;
  /** Authorized content URL for the bytes. Never persisted, never logged. */
  readonly contentUrl: string | null;
  readonly onOpenChange: (open: boolean) => void;
  /** Test seam; production uses the real dynamic `pdfjs-dist` import. */
  readonly loadPdfjs?: PdfjsLoader;
}

/** Width the canvas is laid out at. Bounded again inside `renderPage`. */
const CANVAS_CSS_WIDTH = 760;

type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly document: PdfPreviewDocument }
  | { readonly kind: "error"; readonly message: string };

/**
 * In-app preview for a PDF attachment (Part 44).
 *
 * The bytes are drawn onto a `<canvas>` by `lib/notes/pdf-preview.ts` and never
 * handed to the browser's own viewer — see that module's header for why an
 * `<iframe>`, `<embed>`, or `<object>` is not an option here.
 *
 * ## Accessibility
 *
 * A canvas is opaque to assistive technology, so this dialog does not pretend
 * otherwise. It states plainly that the preview is a visual rendering, names the
 * file and the page position in text, keeps page navigation as ordinary buttons
 * with a live region announcing the current page, and keeps Download reachable
 * throughout — because downloading and opening the file in a real PDF reader is
 * the *accessible* path, and it must never be harder to reach than the preview.
 *
 * ## Reduced motion
 *
 * There is no page-turn animation to suppress; what `prefersReducedMotion`
 * changes is the scroll behaviour when a new page is rendered, which would
 * otherwise smooth-scroll the viewport back to the top on every navigation.
 */
export function PdfPreviewDialog({
  target,
  contentUrl,
  onOpenChange,
  loadPdfjs,
}: PdfPreviewDialogProps) {
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [rendering, setRendering] = useState(false);

  const attachmentId = target?.attachmentId ?? null;
  const loaderRef = useRef(loadPdfjs);
  loaderRef.current = loadPdfjs;

  // Load once per opened attachment. Aborting on cleanup is what stops a reader
  // who opens and closes quickly from leaving a fetch and a parsed document
  // behind, and what stops a stale result overwriting a newer one.
  useEffect(() => {
    if (attachmentId === null || contentUrl === null) return;
    const controller = new AbortController();
    let live = true;
    let loaded: PdfPreviewDocument | null = null;

    setState({ kind: "loading" });
    setPage(1);

    void openPdfPreview(contentUrl, controller.signal, loaderRef.current).then(
      (result) => {
        if (!live) {
          if (result.ok) result.document.destroy();
          return;
        }
        if (!result.ok) {
          setState({ kind: "error", message: result.message });
          return;
        }
        loaded = result.document;
        setState({ kind: "ready", document: result.document });
      },
      () => {
        if (live) {
          setState({
            kind: "error",
            message: "This preview could not be loaded. You can still download the file.",
          });
        }
      },
    );

    return () => {
      live = false;
      controller.abort();
      loaded?.destroy();
    };
  }, [attachmentId, contentUrl]);

  const ready = state.kind === "ready" ? state.document : null;
  const pageCount = ready?.pageCount ?? 0;

  // Draw whenever the document or the page changes. The canvas is owned here
  // and mutated imperatively; React never renders into it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (ready === null || canvas === null) return;
    let live = true;
    setRendering(true);
    void ready.renderPage(page, canvas, CANVAS_CSS_WIDTH).then(
      () => {
        if (!live) return;
        setRendering(false);
        scrollRef.current?.scrollTo({
          top: 0,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      },
      () => {
        if (!live) return;
        setRendering(false);
        setState({
          kind: "error",
          message: "This page could not be rendered. You can still download the file.",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [ready, page]);

  const goto = useCallback(
    (next: number): void => {
      setPage((current) => {
        const bounded = Math.max(1, Math.min(next, pageCount === 0 ? current : pageCount));
        return bounded;
      });
    },
    [pageCount],
  );

  if (target === null) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-w-4xl"
        data-testid="attachment-pdf-preview"
      >
        <DialogHeader>
          <DialogTitle className="truncate" title={target.name}>
            {target.name}
          </DialogTitle>
          <DialogDescription>
            A visual preview of this PDF. It is rendered as an image and cannot be read by a screen
            reader — download the file to open it in a PDF reader.
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            Loading preview…
          </p>
        ) : null}

        {state.kind === "error" ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 p-3 text-sm"
            data-testid="attachment-pdf-preview-error"
          >
            {state.message}
          </p>
        ) : null}

        {state.kind === "ready" ? (
          <>
            <div
              ref={scrollRef}
              className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-2"
            >
              {/*
               * `role="img"` with a name, because a canvas is otherwise an empty
               * element to assistive technology. The name says what it is and
               * which page, and the description above says how to read it
               * properly.
               */}
              <canvas
                ref={canvasRef}
                role="img"
                aria-label={`Page ${page} of ${target.name}`}
                className="mx-auto block h-auto max-w-full"
                data-testid="attachment-pdf-canvas"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {rendering ? `Rendering page ${page}…` : `Page ${page} of ${pageCount}`}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  data-testid="attachment-pdf-previous"
                  onClick={() => goto(page - 1)}
                >
                  Previous page
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount}
                  data-testid="attachment-pdf-next"
                  onClick={() => goto(page + 1)}
                >
                  Next page
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {contentUrl === null ? null : (
          <a
            className="text-sm underline underline-offset-4"
            href={contentUrl}
            rel="noopener noreferrer"
            download={target.name}
            data-testid="attachment-pdf-download"
          >
            Download {target.name}
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}
