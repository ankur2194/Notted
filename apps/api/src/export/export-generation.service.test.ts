// The switch itself is exercised end-to-end by `export.worker.service.test.ts`
// and per-format by the converter suites. What is asserted HERE is the one
// thing that is not per-format: the artefact ceiling applies to all six.

import { describe, expect, it } from "vitest";

import { ExportGenerationService } from "./export-generation.service";

import type { ExportSourceDocument } from "./export-renderers";
import type { NoteExportSourceService } from "./note-export-source.service";
import type { PdfExportService } from "./pdf-export.service";
import type { ExportConfig } from "../config/export.config";
import type { ExportOptions, PageSize } from "@notted/shared-types";

const OPTIONS: ExportOptions = {
  includeAttachments: false,
  includeComments: false,
  includeVersionHistory: false,
  headerText: null,
  footerText: null,
  margins: null,
};

/** A document whose text alone is comfortably over the tiny cap used below. */
function source(paragraphs: number): ExportSourceDocument {
  return {
    title: "Roadmap",
    content: {
      type: "doc",
      content: Array.from({ length: paragraphs }, () => ({
        type: "paragraph",
        content: [{ type: "text", text: "x".repeat(256) }],
      })),
    },
    options: OPTIONS,
    pageSize: "a4" as PageSize,
    subject: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      noteId: "22222222-2222-4222-8222-222222222222",
      requestedById: "33333333-3333-4333-8333-333333333333",
      correlationId: null,
    },
  };
}

function service(maxArtifactBytes: number): ExportGenerationService {
  return new ExportGenerationService(
    {} as unknown as PdfExportService,
    {} as unknown as NoteExportSourceService,
    { maxArtifactBytes, renderTimeoutMs: 30_000 } as unknown as ExportConfig,
  );
}

describe("ExportGenerationService artefact ceiling", () => {
  // `pdf` and `zip` check internally; these four never did, so a large note
  // could produce an artefact past the configured cap and still be uploaded.
  it.each(["txt", "html", "markdown", "docx"] as const)(
    "refuses a %s artefact larger than the configured cap",
    async (format) => {
      await expect(service(64).render(format, source(64))).rejects.toThrow(
        /exceeds the maximum export artifact size/u,
      );
    },
  );

  it.each(["txt", "html", "markdown", "docx"] as const)(
    "returns a %s artefact that fits under the cap",
    async (format) => {
      const artifact = await service(50_000_000).render(format, source(1));
      expect(artifact.body.byteLength).toBeGreaterThan(0);
      expect(artifact.mimeType).not.toBe("");
    },
  );
});
