"use client";

import {
  DEFAULT_PAGE_MARGINS,
  DEFAULT_ZOOM,
  MAX_PAGE_MARGINS,
  MIN_PAGE_MARGIN_MM,
  PAGE_SIZE_VALUES,
  ZOOM_FIT_MODES,
  ZOOM_LEVELS,
  canStepZoom,
  clampMargins,
  isZoomFitMode,
  isZoomSelection,
  pageBoundaryOffsets,
  pageBoxPx,
  pageContentHeightPx,
  pageCustomProperties,
  pageSizeLabel,
  preservedScrollOffset,
  resolveZoomScale,
  scaledPageBox,
  zoomLabel,
  zoomLevelStep,
} from "@notted/shared-types";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { NoteSaveProvider, type NoteSaveHandle } from "./note-save-context";
import { PagePrintStyle } from "./PagePrintStyle";
import { SaveStatusIndicator } from "./SaveStatusIndicator";
import { useNoteAutosave } from "./useNoteAutosave";
import { VersionHistory } from "./VersionHistory";

import type {
  NoteDocument,
  PageMargins,
  PageSize,
  PixelBox,
  ZoomSelection,
} from "@notted/shared-types";

import { PAGE_BREAK_CLASS } from "@/components/editor/extensions/page-break";
import { FormField } from "@/components/ui/form-controls";
import { setFocusMode, useFocusMode } from "@/lib/notes/focus-mode";
import {
  browserStorage,
  readPagePreferences,
  writePagePreferences,
} from "@/lib/notes/page-preferences";

const CONTROL_CLASSES =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-disabled:opacity-50";

function zoomOptionValue(selection: ZoomSelection): string {
  return typeof selection === "number" ? String(selection) : selection;
}

function parseZoomOption(raw: string): ZoomSelection | null {
  if (isZoomFitMode(raw)) return raw;
  const numeric = Number.parseFloat(raw);
  return isZoomSelection(numeric) ? numeric : null;
}

const FOCUS_ON_MESSAGE =
  "Focus mode on. The navigation, top bar, and page controls are hidden, and a minimal toolbar floats over the page. Press Escape to leave focus mode.";
const FOCUS_OFF_MESSAGE = "Focus mode off. The full layout is restored.";

export interface PageContainerProps {
  readonly workspaceId: string;
  readonly noteId: string;
  /** Server-rendered effective page size for this note (the workspace default is already applied). */
  readonly initialPageSize: PageSize;
  /** Server-rendered note version; the optimistic mutation below owns it from here. */
  readonly initialVersion: number;
  readonly initialDocument?: NoteDocument;
  /** Backend policy remains authoritative; this only decides whether a control is offered. */
  readonly canUpdate: boolean;
  readonly children: ReactNode;
}

/**
 * The white A4/US Letter sheet the editor is written on (Notted.md "White
 * A4/Letter Page Layout", Plan Parts 37 and 38).
 *
 * Responsibilities kept here and nowhere else: physical page geometry,
 * configurable margins, the paper and workspace surfaces, zoom (five fixed
 * levels plus fit-width and fit-page), switching the note's page size, the
 * dashed page-boundary guides, the focus-mode toggle, and the `@page` rule.
 *
 * Explicitly *not* here:
 * - Page-break *content*. An explicit break is the `pageBreak` contract node,
 *   inserted by the editor; this component only measures where the nodes ended
 *   up. See `components/editor/extensions/page-break.ts`.
 * - Print rules — `styles/print.css`, kept standalone for Part 63's exporter.
 * - Save *policy* — `lib/notes/autosave-machine.ts`. This component owns the
 *   machine instance (Part 39), because it is the nearest client ancestor of
 *   both the page-size control and the editor, and the two must share one
 *   version cell: the API bumps `version` on every update, so a settings save
 *   and a content save would otherwise invalidate each other's precondition.
 * - Any change to stored content. Pagination is a rendering concern; the paper
 *   uses `min-height`, so a long note simply grows one continuous sheet and the
 *   stored TipTap document never learns that a page boundary exists. The guides
 *   below are derived measurements and are never written back.
 */
export function PageContainer({
  workspaceId,
  noteId,
  initialPageSize,
  initialVersion,
  initialDocument = { type: "doc", content: [] } as NoteDocument,
  canUpdate,
  children,
}: PageContainerProps) {
  const zoomSelectId = useId();
  const marginXId = useId();
  const marginYId = useId();

  /**
   * The one autosave machine for this note: one version cell, one in-flight
   * request, page-size changes and document changes coalesced into a single
   * PATCH. See `lib/notes/autosave-machine.ts` for why that is not optional.
   */
  const autosave = useNoteAutosave({
    workspaceId,
    noteId,
    initialVersion,
    initialPageSize,
    canUpdate,
  });
  const pageSize = autosave.pageSize;

  // The editor is `children` handed down by a Server Component, so it collects
  // this handle from context instead of receiving it as a prop.
  const saveHandle = useMemo<NoteSaveHandle>(
    () => ({
      onDocumentChange: autosave.onDocumentChange,
      onDocumentBaseline: autosave.onDocumentBaseline,
      onDocumentRejected: autosave.onDocumentRejected,
      applyExternalVersion: autosave.applyExternalVersion,
      status: autosave.status,
      hasUnsavedWork: autosave.hasUnsavedWork,
      registerUnsavedWorkProbe: autosave.registerUnsavedWorkProbe,
    }),
    [
      autosave.onDocumentChange,
      autosave.onDocumentBaseline,
      autosave.onDocumentRejected,
      autosave.applyExternalVersion,
      autosave.status,
      autosave.hasUnsavedWork,
      autosave.registerUnsavedWorkProbe,
    ],
  );

  const [status, setStatus] = useState("");

  const [zoom, setZoom] = useState<ZoomSelection>(DEFAULT_ZOOM);
  const [margins, setMargins] = useState<PageMargins>(DEFAULT_PAGE_MARGINS);
  const [marginDraft, setMarginDraft] = useState({
    x: String(DEFAULT_PAGE_MARGINS.x),
    y: String(DEFAULT_PAGE_MARGINS.y),
  });

  const [viewport, setViewport] = useState<PixelBox>({ width: 0, height: 0 });
  const [paperHeight, setPaperHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [flowOffset, setFlowOffset] = useState(0);
  const [explicitBreaks, setExplicitBreaks] = useState<readonly number[]>([]);

  const focusMode = useFocusMode();
  const focusToggleRef = useRef<HTMLButtonElement | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Preferences are read after mount so the server and first client render agree.
  useEffect(() => {
    const stored = readPagePreferences(browserStorage());
    setZoom(stored.zoom);
    setMargins(stored.margins);
    setMarginDraft({ x: String(stored.margins.x), y: String(stored.margins.y) });
  }, []);

  // Read at measurement time rather than captured, so `measure` never has to be
  // rebuilt (and the observer never has to be torn down) when the zoom changes.
  const scaleRef = useRef(1);

  /**
   * The flowed prose column — the only part of the page that actually prints.
   *
   * `.notted-page-content` also carries the editor toolbar and the migration /
   * read-only notices, all of which `print.css` hides. Measuring the wrapper
   * would therefore push every implicit boundary down by the toolbar's height
   * (roughly 12% of an A4 column), so the guides would sit well away from where
   * the sheet really breaks. Pagination is measured from the ProseMirror
   * element instead, and `flowOffset` carries the gap so the overlay still
   * lines up with the paper.
   */
  const flowElement = useCallback((): HTMLElement | null => {
    const content = contentRef.current;
    if (content === null) return null;
    return content.querySelector<HTMLElement>(".notted-editor-content") ?? content;
  }, []);

  /**
   * Offsets of the explicit `pageBreak` nodes, relative to the top of the
   * flowed column and in *unscaled* layout pixels.
   *
   * Read-only: the document is queried, never touched. Rects are used rather
   * than `offsetTop` because the whole subtree sits inside a `scale()`
   * transform, so the measured distance is divided back out by the current
   * scale. jsdom reports every rect as zero, which yields no usable offsets and
   * therefore no guides — the arithmetic itself is proved in `page-geometry`.
   */
  const readExplicitBreaks = useCallback((): readonly number[] => {
    const flow = flowElement();
    if (flow === null) return [];
    const scale = scaleRef.current;
    if (!Number.isFinite(scale) || scale <= 0) return [];
    const origin = flow.getBoundingClientRect().top;
    const offsets: number[] = [];
    for (const element of flow.querySelectorAll(`.${PAGE_BREAK_CLASS}`)) {
      const offset = (element.getBoundingClientRect().top - origin) / scale;
      if (Number.isFinite(offset) && offset > 0) offsets.push(offset);
    }
    return offsets;
  }, [flowElement]);

  const measure = useCallback((): void => {
    const viewportElement = viewportRef.current;
    if (viewportElement !== null) {
      const next = {
        width: viewportElement.clientWidth,
        height: viewportElement.clientHeight,
      };
      setViewport((current) => {
        if (current.width === next.width && current.height === next.height) return current;
        return next;
      });
    }
    const paperElement = paperRef.current;
    if (paperElement !== null) {
      // `offsetHeight` is the *layout* height and ignores the scale transform,
      // which is exactly what the scaled wrapper below must be derived from.
      const height = paperElement.offsetHeight;
      setPaperHeight((current) => (current === height ? current : height));
    }
    const contentElement = contentRef.current;
    const flow = flowElement();
    if (contentElement !== null && flow !== null) {
      // The flowed column's own height, independent of the paper's `min-height`,
      // so a note shorter than one sheet is not mistaken for a full page.
      const height = flow.offsetHeight;
      setContentHeight((current) => (current === height ? current : height));
      // Distance from the paper's content box to the first printed line, in
      // unscaled pixels. Everything above it (toolbar, notices) is chrome that
      // `print.css` removes, so it must not shift where the guides are drawn.
      const scale = scaleRef.current;
      const offset =
        Number.isFinite(scale) && scale > 0
          ? (flow.getBoundingClientRect().top - contentElement.getBoundingClientRect().top) / scale
          : 0;
      const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
      setFlowOffset((current) => (current === safeOffset ? current : safeOffset));
    }
    const breaks = readExplicitBreaks();
    setExplicitBreaks((current) =>
      current.length === breaks.length && current.every((value, index) => value === breaks[index])
        ? current
        : breaks,
    );
  }, [readExplicitBreaks]);

  useEffect(() => {
    measure();
    // jsdom implements no `ResizeObserver`, and neither does a server render.
    // Without measurement the fit modes resolve to 100% rather than failing, so
    // the container degrades to the five fixed levels instead of breaking.
    //
    // Measurement is driven entirely by resize notifications — never by a
    // render — because reading layout out of the whole content column on every
    // render is exactly the cost Part 35 avoided by only probing the document
    // while the table dialog is open. Editing the note changes the content
    // column's height, which is what wakes this observer.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    if (viewportRef.current !== null) observer.observe(viewportRef.current);
    if (paperRef.current !== null) observer.observe(paperRef.current);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    const flow = flowElement();
    if (flow !== null && flow !== contentRef.current) observer.observe(flow);
    return () => observer.disconnect();
  }, [measure, flowElement]);

  const scale = resolveZoomScale(zoom, viewport, pageSize);
  scaleRef.current = scale;
  const nominal = pageBoxPx(pageSize);
  const scaled = scaledPageBox(
    { width: nominal.width, height: Math.max(paperHeight, nominal.height) },
    scale,
  );

  /**
   * Non-destructive overflow indication.
   *
   * Every guide below is derived from two measured heights and the measured
   * positions of the explicit break nodes. Nothing here writes to the document:
   * where the sheets fall is a rendering question, and the stored TipTap JSON
   * never learns that a boundary exists (Part 37).
   */
  const boundaries = pageBoundaryOffsets({
    contentHeight,
    pageContentHeight: pageContentHeightPx(pageSize, margins),
    explicitBreaks,
  });

  // Keep the same content under the caret across a zoom change. Without this a
  // reader zooming in loses their place: the scroll extents grow but the offset
  // does not, so the viewport jumps towards the top of the sheet.
  const previousScale = useRef(scale);
  useEffect(() => {
    const element = viewportRef.current;
    const before = previousScale.current;
    previousScale.current = scale;
    if (element === null || before === scale) return;
    element.scrollTop = preservedScrollOffset(element.scrollTop, before, scale);
    element.scrollLeft = preservedScrollOffset(element.scrollLeft, before, scale);
  }, [scale]);

  /**
   * Restore the prior layout when this page goes away.
   *
   * `data-notted-focus` lives on `document.documentElement`, so a mode left
   * applied would hide the navigation on every other page in the application.
   * The cleanup runs whether focus mode was left through the toggle, through
   * Escape, or by navigating away mid-session.
   */
  useEffect(
    () => () => {
      setFocusMode(false);
    },
    [],
  );

  // Announce every entry and exit, however it was triggered: the toggle button,
  // `Mod-Shift-f` inside the editor, or Escape. The first run is skipped so
  // mounting the page never announces a mode nobody chose.
  const announcedFocus = useRef(focusMode);
  useEffect(() => {
    if (announcedFocus.current === focusMode) return;
    announcedFocus.current = focusMode;
    setStatus(focusMode ? FOCUS_ON_MESSAGE : FOCUS_OFF_MESSAGE);
  }, [focusMode]);

  /**
   * Escape leaves focus mode and returns focus to the control that entered it,
   * following the `useDialogFocusRestore` pattern.
   *
   * `defaultPrevented` is respected so an open slash, mention, or dialog surface
   * — each of which consumes Escape and calls `preventDefault` — closes first
   * and focus mode survives that press.
   */
  useEffect(() => {
    if (!focusMode) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setFocusMode(false);
      focusToggleRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusMode]);

  function persistPreferences(nextZoom: ZoomSelection, nextMargins: PageMargins): void {
    writePagePreferences(browserStorage(), { zoom: nextZoom, margins: nextMargins });
  }

  function selectZoom(next: ZoomSelection): void {
    setZoom(next);
    persistPreferences(next, margins);
    const resolved = resolveZoomScale(next, viewport, pageSize);
    setStatus(
      typeof next === "number"
        ? `Zoom set to ${zoomLabel(next)}.`
        : `Zoom set to ${zoomLabel(next)}, ${Math.round(resolved * 100)}%.`,
    );
  }

  function stepZoom(direction: 1 | -1): void {
    if (!canStepZoom(scale, direction)) return;
    selectZoom(zoomLevelStep(scale, direction));
  }

  function commitMargin(axis: keyof PageMargins, raw: string): void {
    const parsed = Number.parseFloat(raw);
    const requested = Number.isNaN(parsed) ? margins[axis] : parsed;
    const next = clampMargins(
      axis === "x" ? { x: requested, y: margins.y } : { x: margins.x, y: requested },
    );
    setMargins(next);
    setMarginDraft({ x: String(next.x), y: String(next.y) });
    persistPreferences(zoom, next);
  }

  /**
   * PART 39: the page-size change is a *settings* change, queued on the same
   * machine as the document.
   *
   * It is not debounced — a discrete control press is an explicit act — so it
   * flushes immediately, carrying any pending document text along in the same
   * PATCH under one `expectedVersion`. It is also not blocked while a save is in
   * flight: a second press simply joins the next patch, which is why there is no
   * `aria-disabled` gate here that could strand a focused control.
   *
   * Outcome copy lives in `SaveStatusIndicator`; this only announces the
   * acknowledged size, because the header's page-size badge is server-rendered
   * and would otherwise be the only thing telling the truth.
   */
  function persistPageSize(next: PageSize): void {
    if (!canUpdate || next === pageSize) return;
    autosave.requestPageSize(next);
    setStatus(`Switching page size to ${pageSizeLabel(next)}…`);
  }

  // Announce only what the server confirmed. The first run is skipped so
  // mounting the page never announces a size nobody chose.
  const announcedPageSize = useRef(autosave.savedPageSize);
  useEffect(() => {
    if (announcedPageSize.current === autosave.savedPageSize) return;
    announcedPageSize.current = autosave.savedPageSize;
    setStatus(`Page size is now ${pageSizeLabel(autosave.savedPageSize)}.`);
  }, [autosave.savedPageSize]);

  const paperStyle = {
    ...pageCustomProperties(pageSize, margins),
    // `translateX(-50%)` centres the unscaled box on the wrapper before the
    // scale is applied about the top centre, so the painted sheet lines up with
    // the wrapper that reserves its scaled space at every zoom level.
    transform: `translateX(-50%) scale(${scale})`,
  } as CSSProperties;

  return (
    <div className="notted-page-region">
      <PagePrintStyle size={pageSize} margins={margins} />
      <div
        className="notted-page-controls mb-3 flex flex-wrap items-end gap-x-4 gap-y-3"
        role="group"
        aria-label="Page layout"
      >
        {/*
         * Focus mode hides the layout controls but never this toggle: a control
         * that disappears the moment it is used leaves no way back by mouse, and
         * nothing for Escape to return focus to.
         */}
        <div
          className="flex items-end gap-1"
          role="group"
          aria-label="Zoom controls"
          data-notted-focus-hide
          data-notted-print-hide
        >
          <button
            type="button"
            className={CONTROL_CLASSES}
            aria-label="Zoom out"
            aria-disabled={canStepZoom(scale, -1) ? undefined : true}
            onClick={() => stepZoom(-1)}
          >
            <span aria-hidden="true">-</span>
          </button>
          <div className="flex flex-col gap-1">
            <label htmlFor={zoomSelectId} className="text-xs font-medium text-muted-foreground">
              Zoom
            </label>
            <select
              id={zoomSelectId}
              className="min-h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={zoomOptionValue(zoom)}
              onChange={(event) => {
                const next = parseZoomOption(event.target.value);
                if (next !== null) selectZoom(next);
              }}
            >
              {ZOOM_LEVELS.map((level) => (
                <option key={level} value={String(level)}>
                  {zoomLabel(level)}
                </option>
              ))}
              {ZOOM_FIT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {zoomLabel(mode)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={CONTROL_CLASSES}
            aria-label="Zoom in"
            aria-disabled={canStepZoom(scale, 1) ? undefined : true}
            onClick={() => stepZoom(1)}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>

        {canUpdate ? (
          <div
            className="flex items-end gap-1"
            role="group"
            aria-label="Page size"
            data-notted-focus-hide
            data-notted-print-hide
          >
            {PAGE_SIZE_VALUES.map((size) => (
              <button
                key={size}
                type="button"
                className={CONTROL_CLASSES}
                aria-pressed={pageSize === size}
                // Never `disabled`, and never gated on a save being in flight: a
                // press during a save is queued into the next patch, and a
                // control that leaves the tab order mid-interaction is the trap
                // Part 34 avoided.
                onClick={() => persistPageSize(size)}
              >
                {pageSizeLabel(size)}
              </button>
            ))}
          </div>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            role="note"
            data-notted-focus-hide
            data-notted-print-hide
          >
            Page size: {pageSizeLabel(pageSize)}. Changing it requires edit access.
          </p>
        )}

        <div
          className="flex flex-wrap items-end gap-x-4 gap-y-3"
          data-notted-focus-hide
          data-notted-print-hide
        >
          <FormField
            id={marginXId}
            label="Side margin (mm)"
            type="number"
            inputMode="numeric"
            min={MIN_PAGE_MARGIN_MM}
            max={MAX_PAGE_MARGINS.x}
            step={1}
            className="h-11 w-24"
            value={marginDraft.x}
            onChange={(event) =>
              setMarginDraft((current) => ({ ...current, x: event.target.value }))
            }
            onBlur={(event) => commitMargin("x", event.target.value)}
          />
          <FormField
            id={marginYId}
            label="Top and bottom margin (mm)"
            type="number"
            inputMode="numeric"
            min={MIN_PAGE_MARGIN_MM}
            max={MAX_PAGE_MARGINS.y}
            step={1}
            className="h-11 w-24"
            value={marginDraft.y}
            onChange={(event) =>
              setMarginDraft((current) => ({ ...current, y: event.target.value }))
            }
            onBlur={(event) => commitMargin("y", event.target.value)}
          />
        </div>

        <button
          ref={focusToggleRef}
          type="button"
          className={CONTROL_CLASSES}
          // `aria-pressed`, not a swapped label: the control is one toggle whose
          // state assistive technology reads, and it keeps its accessible name
          // across both states so focus restoration lands somewhere recognisable.
          aria-pressed={focusMode}
          data-notted-print-hide
          onClick={() => setFocusMode(!focusMode)}
        >
          Focus mode
        </button>
        <div data-notted-focus-hide data-notted-print-hide>
          <VersionHistory
            workspaceId={workspaceId}
            noteId={noteId}
            currentVersion={autosave.version}
            currentDocument={autosave.savedDocument ?? initialDocument}
            canRestore={canUpdate}
            saveStatus={autosave.status}
            hasUnsavedWork={autosave.hasUnsavedWork}
            hasUnacknowledgedWork={autosave.hasUnacknowledgedWork}
          />
        </div>
      </div>

      {/*
       * Layout announcements (zoom, margins, focus mode, the acknowledged page
       * size). Save state has its own region below so a zoom change can never
       * overwrite "Couldn't save" — and so neither announcement has to wait for
       * the other.
       */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="mb-2 min-h-6 text-sm text-muted-foreground"
        data-testid="note-layout-status"
        data-notted-print-hide
      >
        {status}
      </div>

      {canUpdate ? (
        <SaveStatusIndicator
          status={autosave.status}
          description={autosave.description}
          documentRejected={autosave.documentRejected}
          onRetry={autosave.retry}
          onReload={autosave.reload}
        />
      ) : null}

      <div
        ref={viewportRef}
        className="notted-page-viewport"
        role="region"
        aria-label="Note page"
        /*
         * WCAG 2.2 SC 2.1.1: a scrollable region must be operable from the
         * keyboard. Browsers only make a scroller focusable implicitly when it
         * has no focusable children, which is never true here — the editor
         * lives inside it — so the tab stop is declared. It is a region with an
         * accessible name and traps nothing: everything inside keeps its own
         * place in the tab order. Removing this would remove keyboard
         * scrolling, which is the accessibility failure the rule exists to
         * prevent; the suppression sits on the attribute the rule reports.
         */
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard-scrollable region, see above
        tabIndex={0}
      >
        <div
          className="notted-page-scale"
          style={{ width: `${scaled.width}px`, height: `${scaled.height}px` }}
        >
          <div
            ref={paperRef}
            className="notted-page-paper"
            style={paperStyle}
            data-testid="notted-page-paper"
            data-page-size={pageSize}
            data-zoom-scale={scale}
          >
            {/*
             * The flowed column, measured on its own so the paper's
             * `min-height` cannot make a short note look like a full page. It
             * adds no styling of its own; the margins remain the paper's
             * padding.
             */}
            <div ref={contentRef} className="notted-page-content">
              {/*
               * The provider is mounted exactly when `SaveStatusIndicator` is
               * rendered, i.e. only when this note can be updated. That keeps
               * one rule honest: a save host exists if and only if something is
               * displaying save state. A read-only note has no host, so the
               * editor keeps its own contract-rejection alert instead of
               * handing announcement to a surface that is not on screen.
               */}
              {canUpdate ? (
                <NoteSaveProvider value={saveHandle}>{children}</NoteSaveProvider>
              ) : (
                children
              )}
            </div>
            {/*
             * The dashed page-boundary guides.
             *
             * Every guide is a derived measurement: nothing here is stored, and
             * the overlay is hidden from assistive technology and from pointer
             * events so the editor underneath keeps every click and caret
             * position. Screen-reader users are not shown a decorative line at
             * all — an explicit break is announced by the `pageBreak` node's own
             * `role="separator"`, which is the part that is real content.
             *
             * Note also that this whole subtree is inside a `scale()`
             * transform. Part 36 recorded that a transformed ancestor changes
             * what `Range.getBoundingClientRect()` reports — but that rect is
             * already in viewport coordinates, and `SuggestionPopover` portals
             * its list to `document.body` and positions it `fixed` from those
             * same coordinates. So the slash and mention popovers do *not*
             * render inside this subtree and are not scaled by it: they stay
             * anchored to the caret at every zoom level while their own chrome
             * keeps its normal size. That is the intended behaviour.
             */}
            <div className="notted-page-breaks" aria-hidden="true" data-notted-print-hide>
              {boundaries.map((boundary) => (
                <div
                  key={`${boundary.kind}-${boundary.offset}`}
                  className="notted-page-break-guide"
                  data-page-boundary={boundary.kind}
                  // `boundary.offset` is measured from the first printed line;
                  // the overlay starts at the paper's content box, so the
                  // chrome above the prose is added back here.
                  style={{ top: `${flowOffset + boundary.offset}px` }}
                >
                  <span className="notted-page-break-guide-label">Page {boundary.page + 1}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
