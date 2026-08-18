// Part 63 — THE format switch, and THE extension point for Part 64.
//
// WHY THIS EXISTS AT ALL. Part 62 kept the switch in `export-renderers.ts` as
// one synchronous, dependency-free function. `pdf` broke that: it needs an
// injected Chromium, so it is asynchronous and has a dependency. The choice was
// to either smuggle a service locator into a pure module or to move the switch
// up one level into something Nest can inject into. This is that one level.
//
// PART 64: ADDING A FORMAT IS ONE `case` ARM HERE PLUS ONE ENTRY IN
// `SUPPORTED_EXPORT_FORMATS`. That is the entire contract. Specifically:
//   - a PURE format (`markdown`) → write the renderer in `export-renderers.ts`
//     and call it from a `case` here, exactly like `txt` and `html`;
//   - a format needing a dependency (`docx`, `zip` and its attachment bytes) →
//     inject the collaborator into THIS constructor and call it from its `case`.
// Do NOT add a plugin registry, a per-format DI token, or a second dispatch
// site. One service, one switch, one arm per format.
//
// NOTHING ELSE CHANGES WHEN A FORMAT LANDS. `export.worker.service.ts` already
// treats this as a closed box that returns bytes or throws, and
// `EXPORT_FORMAT_MEDIA` already carries the media facts for all six formats.

import { Inject, Injectable } from "@nestjs/common";

import { EXPORT_CONFIG, type ExportConfig } from "../config/export.config";

import { renderDocx } from "./converters/docx";
import { renderMarkdown } from "./converters/markdown";
import { DEFAULT_ZIP_BOUNDS, renderZipArchive } from "./converters/zip";
import {
  EXPORT_FORMAT_MEDIA,
  UnsupportedExportFormatError,
  renderPlainText,
  renderStandaloneHtml,
  resolveExportMargins,
  type ExportArtifact,
  type ExportSourceDocument,
} from "./export-renderers";
import { NoteExportSourceService } from "./note-export-source.service";
import { PdfExportService } from "./pdf-export.service";

import type { ExportFormat } from "@notted/shared-types";

@Injectable()
export class ExportGenerationService {
  constructor(
    private readonly pdf: PdfExportService,
    // Part 64. Only `zip` uses this; it is injected here rather than in the
    // worker so the worker keeps treating generation as a closed box.
    private readonly noteSource: NoteExportSourceService,
    @Inject(EXPORT_CONFIG) private readonly config: ExportConfig,
  ) {}

  /**
   * Render one source document into the bytes plus the two content-type facts
   * the worker needs to store and serve them.
   *
   * Throws `UnsupportedExportFormatError` for a format with no renderer, and
   * anything else for a genuine generation failure. The worker maps the first
   * to `format_unsupported` and everything else to `generation_failed`; it does
   * not need to know which format failed or why.
   */
  async render(format: ExportFormat, source: ExportSourceDocument): Promise<ExportArtifact> {
    const artifact = await this.renderFormat(format, source);
    // THE artefact ceiling, applied once for every format.
    //
    // `pdf` and `zip` also check internally, and those checks stay: the PDF one
    // avoids copying an oversized buffer, and the zip bound stops FETCHING
    // attachment bytes rather than discarding them afterwards. Neither covers
    // `html`, `markdown`, `txt` or `docx`, which were bounded only transitively
    // by the note document limits — a large note with many inlined data: URIs
    // could exceed the configured cap and still be uploaded. A plain `Error`
    // matches the PDF path, so the worker records `generation_failed` either way.
    if (artifact.body.byteLength > this.config.maxArtifactBytes) {
      throw new Error(`Generated ${format} export exceeds the maximum export artifact size`);
    }
    return artifact;
  }

  private async renderFormat(
    format: ExportFormat,
    source: ExportSourceDocument,
  ): Promise<ExportArtifact> {
    switch (format) {
      case "txt":
        return renderPlainText(source);
      case "html":
        return renderStandaloneHtml(source);
      case "pdf":
        return this.renderPdf(source);
      case "markdown":
        return renderMarkdown(source);
      case "docx":
        return renderDocx(source);
      case "zip":
        return this.renderZip(source);
      // Every `ExportFormat` now has an arm, so this is only reachable for a
      // value outside the union — a hand-inserted or migrated row. It stays a
      // clean, machine-readable refusal rather than a half-written file the
      // download path would happily serve.
      default:
        throw new UnsupportedExportFormatError(format);
    }
  }

  /**
   * The ONE format that is not a pure function of the note body.
   *
   * `NoteExportSourceService.load` re-authorizes `note.read` for the requester
   * and returns ONLY what `options` asked for, so the include flags are enforced
   * at the read, not just at the packaging step — a flag that is off issues no
   * statement at all. The archive then bounds what it packs and records every
   * omission in its own `manifest.json`, so a skipped attachment is visible to
   * the user rather than silently missing.
   *
   * The abort budget reuses `EXPORT_RENDER_TIMEOUT_MS` rather than minting a
   * second timeout knob: it is already the "one artefact may take this long"
   * ceiling, and a zip that is still fetching attachment bytes past it is the
   * same failure the PDF renderer uses it for. The archive seals cleanly on
   * abort — a short honest zip beats a truncated one.
   */
  private async renderZip(source: ExportSourceDocument): Promise<ExportArtifact> {
    const bundle = await this.noteSource.load(source.subject, source.options);
    return renderZipArchive({
      source,
      bundle,
      readAttachment: (objectKey, maxBytes) => this.noteSource.readObject(objectKey, maxBytes),
      signal: AbortSignal.timeout(this.config.renderTimeoutMs),
      // The artefact ceiling is configuration, so it overrides the module
      // default here rather than being restated inside the converter.
      bounds: { ...DEFAULT_ZIP_BOUNDS, maxTotalBytes: this.config.maxArtifactBytes },
    });
  }

  /**
   * The PDF is rendered from the EXACT string the `html` export ships.
   *
   * That is deliberate and load-bearing: one document builder means the PDF
   * cannot drift from the HTML, and neither can drift from what the editor
   * prints, because all three get their geometry from `pageRuleCss` and their
   * rules from the shared `print.css`.
   *
   * `PdfExportService.render` throws `ChromiumUnavailableError` when the binary
   * is missing. That surfaces as `generation_failed` on the job row and leaves
   * `html` and `txt` working — a deployment without Chromium loses one format,
   * not the export feature.
   */
  private async renderPdf(source: ExportSourceDocument): Promise<ExportArtifact> {
    const html = renderStandaloneHtml(source);
    const body = await this.pdf.render({
      html: html.body.toString("utf8"),
      margins: resolveExportMargins(source.options),
      headerText: source.options.headerText,
      footerText: source.options.footerText,
    });
    return Object.freeze({ body, ...EXPORT_FORMAT_MEDIA.pdf });
  }
}
