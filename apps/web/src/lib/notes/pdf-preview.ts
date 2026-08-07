/**
 * In-app PDF preview, rendered to `<canvas>` (Part 44).
 *
 * ## Why a canvas and never a frame
 *
 * The obvious implementation is `<iframe src={contentUrl}>`, and it is the one
 * thing this must not do. A PDF is an *active* format — it carries JavaScript,
 * embedded files, and external references — and handing it to the browser's
 * built-in viewer executes it in a document context. ADR 0005 is explicit that
 * untrusted content is never served inline, and the API backs that up: every
 * generic file leaves with `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`, so a frame pointed at the content endpoint
 * would download rather than render anyway.
 *
 * Rendering with `pdfjs-dist` inverts the trust: the bytes are parsed by a
 * library into drawing operations, and the only thing that reaches the page is
 * pixels on a canvas the application owns. No script in the document can run, no
 * embedded file can be opened, and no annotation can navigate anywhere —
 * `isEvalSupported: false` closes pdf.js's own optional `Function` compilation,
 * and the annotation layer is simply never built.
 *
 * ## No external fetches, ever
 *
 * `disableAutoFetch` and `disableStream` keep pdf.js from issuing range requests
 * of its own: the bytes are fetched **once**, here, through the authorized
 * content endpoint with the session cookie, and handed over as an
 * `ArrayBuffer`. `cMapUrl` and `standardFontDataUrl` are deliberately left
 * unset, so a document referencing a CJK CMap or a non-embedded standard font
 * degrades to a substitute glyph rather than reaching for a CDN — which the
 * page's CSP would refuse regardless.
 *
 * ## No React, no DOM ownership
 *
 * Everything here is a plain function over a `<canvas>` the caller owns, for the
 * same reason the upload queue has no React in it: the dialog can then be tested
 * as a component and this can be tested as logic.
 */

/**
 * Ceiling on the bytes fetched for a preview.
 *
 * An attachment may be up to 50 MiB, and parsing one of those in the main
 * browser process to *look* at page one is a poor trade. Beyond this the reader
 * is told to download instead — which always works, and is the action they were
 * heading for anyway.
 */
export const MAX_PDF_PREVIEW_BYTES = 25 * 1_024 * 1_024;

/** Rendered CSS width cap; the device pixel ratio is applied on top. */
export const MAX_PDF_PREVIEW_WIDTH = 1_400;

/** Backstop on the backing-store scale, so a huge page cannot exhaust memory. */
const MAX_RENDER_SCALE = 4;

export type PdfPreviewFailure = "unavailable" | "forbidden" | "too-large" | "invalid";

export interface PdfPreviewDocument {
  readonly pageCount: number;
  /**
   * Draw one 1-based page into `canvas`, sized to `cssWidth`.
   *
   * Resolves when the page is on screen. Rejects only on a genuine render
   * fault; a cancelled render settles quietly, because a reader paging quickly
   * has not encountered an error.
   */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  destroy(): void;
}

export type PdfPreviewResult =
  | { readonly ok: true; readonly document: PdfPreviewDocument }
  | { readonly ok: false; readonly reason: PdfPreviewFailure; readonly message: string };

/* -------------------------------------------------------------------------- */
/* The narrow slice of `pdfjs-dist` this module uses                            */
/* -------------------------------------------------------------------------- */

/**
 * Structural types for exactly the pdf.js surface used below.
 *
 * Declared locally rather than imported from `pdfjs-dist/types` on purpose. The
 * import is dynamic — the ~350 KB library must not be in the note bundle for the
 * overwhelming majority of readers who never open a preview — and a *type* import
 * alongside it would tie type-checking to a package layout that has changed
 * shape twice in recent majors. Naming the four calls used here instead means a
 * pdf.js upgrade fails at this one boundary rather than anywhere else, and it
 * keeps the module unit-testable through `loadPdfjs` without the real library.
 */
interface PdfViewport {
  readonly width: number;
  readonly height: number;
}

interface PdfRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

interface PdfPage {
  getViewport(parameters: { scale: number }): PdfViewport;
  render(parameters: { canvas: HTMLCanvasElement; viewport: PdfViewport }): PdfRenderTask;
  cleanup(): void;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

export interface PdfjsModule {
  readonly GlobalWorkerOptions: { workerSrc: string };
  getDocument(parameters: {
    data: ArrayBuffer;
    isEvalSupported: boolean;
    disableAutoFetch: boolean;
    disableStream: boolean;
    useWorkerFetch: boolean;
    isOffscreenCanvasSupported: boolean;
  }): PdfLoadingTask;
}

/** Injected in tests; production always resolves the real dynamic import. */
export type PdfjsLoader = () => Promise<PdfjsModule>;

let workerConfigured = false;

/**
 * Resolve the worker as a **bundled local asset**.
 *
 * `new URL(…, import.meta.url)` is the form bundlers recognise, so the worker is
 * emitted into the application's own output and served same-origin. That matters
 * for more than tidiness: the page's CSP allows no external hosts, so the usual
 * "point `workerSrc` at a CDN build" instruction would produce a preview that
 * silently never renders.
 *
 * If the worker cannot be constructed, pdf.js falls back to parsing on the main
 * thread. That is slower and can jank a large document, but it renders — a
 * degraded preview is a better outcome than a dialog that only ever fails.
 */
function configureWorker(pdfjs: PdfjsModule): void {
  if (workerConfigured) return;
  workerConfigured = true;
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.mjs",
      import.meta.url,
    ).toString();
  } catch {
    // Leave pdf.js to its own fallback rather than failing the preview.
  }
}

const defaultLoader: PdfjsLoader = async () =>
  (await import("pdfjs-dist")) as unknown as PdfjsModule;

/**
 * Fetch the bytes through the authorized content endpoint.
 *
 * `credentials: "include"` is what carries the session cookie to the API origin;
 * the endpoint re-checks workspace membership on every request, so this is the
 * *only* thing that makes the preview safe to offer at all. The URL is never
 * logged and never persisted — the note document has no attribute that could
 * hold one.
 */
type PdfBytesResult =
  | { readonly ok: true; readonly bytes: ArrayBuffer }
  | { readonly ok: false; readonly reason: PdfPreviewFailure };

async function fetchPdfBytes(url: string, signal: AbortSignal): Promise<PdfBytesResult> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!response.ok) {
    const forbidden = response.status === 401 || response.status === 403 || response.status === 404;
    return { ok: false, reason: forbidden ? "forbidden" : "unavailable" };
  }
  // Checked before buffering so an oversized file is refused without ever being
  // held in memory. A missing header falls through to the post-read check below,
  // which is the same bound applied one step later.
  const declared = Number(response.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PDF_PREVIEW_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (bytes.byteLength === 0) return { ok: false, reason: "invalid" };
  if (bytes.byteLength > MAX_PDF_PREVIEW_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true, bytes };
}

export const PDF_PREVIEW_MESSAGES: Readonly<Record<PdfPreviewFailure, string>> = Object.freeze({
  unavailable: "This preview could not be loaded. You can still download the file.",
  forbidden: "You no longer have permission to view this file.",
  "too-large": "This file is too large to preview here. Download it to open it.",
  invalid: "This file could not be read as a PDF. You can still download it.",
});

/**
 * Fetch and parse one PDF, ready to render.
 *
 * Returns a failure envelope rather than throwing: every branch here is a state
 * the reader has to be *shown*, and an exception would have to be translated
 * back into one anyway.
 */
export async function openPdfPreview(
  url: string,
  signal: AbortSignal,
  loadPdfjs: PdfjsLoader = defaultLoader,
): Promise<PdfPreviewResult> {
  const fetched = await fetchPdfBytes(url, signal);
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason, message: PDF_PREVIEW_MESSAGES[fetched.reason] };
  }

  let pdfjs: PdfjsModule;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    return { ok: false, reason: "unavailable", message: PDF_PREVIEW_MESSAGES.unavailable };
  }
  configureWorker(pdfjs);

  const task = pdfjs.getDocument({
    data: fetched.bytes,
    // Closes pdf.js's optional `new Function` fast path for colour-space and
    // font programs. Slower, and the only setting here that is purely defensive.
    isEvalSupported: false,
    // The bytes are already complete and in memory; both of these stop pdf.js
    // from issuing range or streaming requests of its own.
    disableAutoFetch: true,
    disableStream: true,
    // The worker must never fetch anything either.
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
  });

  let pdf: PdfDocument;
  try {
    pdf = await task.promise;
  } catch {
    // A cancelled load and a corrupt file are indistinguishable here; the caller
    // discards the result when it aborted, so reporting `invalid` is safe.
    void task.destroy();
    return { ok: false, reason: "invalid", message: PDF_PREVIEW_MESSAGES.invalid };
  }

  if (signal.aborted) {
    void pdf.destroy();
    return { ok: false, reason: "unavailable", message: PDF_PREVIEW_MESSAGES.unavailable };
  }

  let active: PdfRenderTask | null = null;

  return {
    ok: true,
    document: {
      pageCount: pdf.numPages,

      renderPage: async (pageNumber, canvas, cssWidth) => {
        // A reader paging quickly must not queue renders on one canvas: pdf.js
        // throws if a second render starts before the first finishes.
        active?.cancel();
        active = null;

        const bounded = Math.max(1, Math.min(pageNumber, pdf.numPages));
        const page = await pdf.getPage(bounded);
        const base = page.getViewport({ scale: 1 });
        const width = Math.max(1, Math.min(cssWidth, MAX_PDF_PREVIEW_WIDTH));
        const ratio = globalThis.devicePixelRatio;
        const density = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
        // Capped, so a poster-sized page on a 3× display cannot allocate a
        // backing store measured in hundreds of megabytes.
        const scale = Math.min((width / base.width) * density, MAX_RENDER_SCALE);
        const viewport = page.getViewport({ scale });

        // The backing store is device pixels; the CSS box stays exactly the
        // width the caller asked for, which is what keeps the page crisp on a
        // high-density display without changing the layout.
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        canvas.style.width = `${width}px`;
        canvas.style.height = "auto";

        const render = page.render({ canvas, viewport });
        active = render;
        try {
          await render.promise;
        } catch {
          // `RenderingCancelledException` is the expected outcome of paging
          // away mid-render and is not an error the reader should ever see.
          return;
        } finally {
          if (active === render) active = null;
          page.cleanup();
        }
      },

      destroy: () => {
        active?.cancel();
        active = null;
        void pdf.destroy();
      },
    },
  };
}
