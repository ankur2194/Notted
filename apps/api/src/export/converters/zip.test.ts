// Part 64 — `renderZipArchive` unit suite.
//
// The renderer is a pure function of rows plus a byte reader, so this suite is
// the pure-converter style (`export-html.test.ts`): no Nest, no database, no
// storage. Every assertion opens the produced bytes with `unzipSync` — asserting
// on the internal bookkeeping instead would let a bug that never actually writes
// an entry pass, which is precisely the bug that matters here.
//
// `./markdown` is mocked to a constant. Its output is another part's contract
// and its exact text is irrelevant to whether the ARCHIVE is correct; pinning it
// here would make this suite fail whenever that renderer improves.

import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ZIP_BOUNDS, renderZipArchive, type ZipBounds } from "./zip";

import type { ExportArtifact, ExportSourceDocument } from "../export-renderers";
import type {
  ExportBundle,
  ExportBundleAttachment,
  ExportBundleComment,
  ExportBundleVersion,
} from "../note-export-source.service";
import type { ExportOptions } from "@notted/shared-types";

vi.mock("./markdown", () => ({ documentToMarkdown: () => "BODY" }));

const workspaceId = "64000000-0000-4000-8100-000000000001";
const noteId = "64000000-0000-4000-8500-000000000002";

interface ManifestEntry {
  readonly path: string;
  readonly kind: string;
  readonly bytes: number;
  readonly attachmentId?: string;
}
interface ManifestSkip {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}
interface Manifest {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly note: Record<string, unknown>;
  readonly options: Record<string, boolean>;
  readonly entries: readonly ManifestEntry[];
  readonly skipped: readonly ManifestSkip[];
}

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return Object.freeze({
    includeAttachments: false,
    includeComments: false,
    includeVersionHistory: false,
    headerText: null,
    footerText: null,
    margins: null,
    ...overrides,
  });
}

function source(overrides: Partial<ExportSourceDocument> = {}): ExportSourceDocument {
  return Object.freeze({
    title: "Quarterly Plan",
    content: { type: "doc", content: [] },
    options: options(),
    pageSize: "a4" as const,
    subject: { workspaceId, noteId, requestedById: "requester", correlationId: null },
    ...overrides,
  });
}

function attachment(overrides: Partial<ExportBundleAttachment> = {}): ExportBundleAttachment {
  return Object.freeze({
    attachmentId: "att-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 8,
    objectKey: "workspaces/x/att-1",
    ...overrides,
  });
}

function comment(id: string): ExportBundleComment {
  return Object.freeze({
    id,
    parentId: null,
    authorName: "Ada",
    content: "looks good",
    isResolved: false,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
}

function versionRow(number: number): ExportBundleVersion {
  return Object.freeze({
    versionId: `ver-${number}`,
    version: number,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdByName: "Ada",
    content: { type: "doc", content: [] },
  });
}

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return Object.freeze({
    attachments: [attachment()],
    comments: [comment("c1")],
    versions: [versionRow(1)],
    ...overrides,
  });
}

/** Every attachment read succeeds with `size` bytes of filler. */
function reader(size = 8) {
  return vi.fn<(objectKey: string, maxBytes: number) => Promise<Buffer | null>>(() =>
    Promise.resolve(Buffer.alloc(size, 0x41)),
  );
}

function open(artifact: ExportArtifact): {
  readonly files: Record<string, Uint8Array>;
  readonly manifest: Manifest;
} {
  const files = unzipSync(new Uint8Array(artifact.body));
  const raw = files["manifest.json"];
  if (raw === undefined) throw new Error("archive has no manifest");
  return { files, manifest: JSON.parse(strFromU8(raw)) as Manifest };
}

function readJson(files: Record<string, Uint8Array>, path: string): unknown[] {
  const raw = files[path];
  if (raw === undefined) throw new Error(`archive has no ${path}`);
  return JSON.parse(strFromU8(raw)) as unknown[];
}

function render(input: {
  readonly source?: ExportSourceDocument;
  readonly bundle?: ExportBundle;
  readonly readAttachment?: (key: string, maxBytes: number) => Promise<Buffer | null>;
  readonly signal?: AbortSignal;
  readonly bounds?: ZipBounds;
}): Promise<ExportArtifact> {
  return renderZipArchive({
    source: input.source ?? source(),
    bundle: input.bundle ?? bundle(),
    readAttachment: input.readAttachment ?? reader(),
    signal: input.signal ?? new AbortController().signal,
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
  });
}

function bounds(overrides: Partial<ZipBounds>): ZipBounds {
  return Object.freeze({ ...DEFAULT_ZIP_BOUNDS, ...overrides });
}

describe("renderZipArchive", () => {
  it("produces exactly the artifacts each include/exclude combination asked for", async () => {
    // The FULL bundle is handed in every time, so this also proves the renderer
    // keys off `options` and not off "did the caller give me rows" — a `zip`
    // that leaked comments because they happened to be loaded would still pass
    // a test that only ever supplied what it asked for.
    const flags = [false, true];
    const produced: Record<string, readonly string[]> = {};
    for (const includeAttachments of flags) {
      for (const includeComments of flags) {
        for (const includeVersionHistory of flags) {
          const artifact = await render({
            source: source({
              options: options({ includeAttachments, includeComments, includeVersionHistory }),
            }),
          });
          const key = `${Number(includeAttachments)}${Number(includeComments)}${Number(includeVersionHistory)}`;
          produced[key] = open(artifact)
            .manifest.entries.map((entry) => entry.path)
            .sort();
        }
      }
    }

    expect(produced).toEqual({
      "000": ["manifest.json", "note.md"],
      "001": ["manifest.json", "note.md", "versions.json"],
      "010": ["comments.json", "manifest.json", "note.md"],
      "011": ["comments.json", "manifest.json", "note.md", "versions.json"],
      "100": ["attachments/report.pdf", "manifest.json", "note.md"],
      "101": ["attachments/report.pdf", "manifest.json", "note.md", "versions.json"],
      "110": ["attachments/report.pdf", "comments.json", "manifest.json", "note.md"],
      "111": [
        "attachments/report.pdf",
        "comments.json",
        "manifest.json",
        "note.md",
        "versions.json",
      ],
    });
  });

  it("always writes the note document with its title heading", async () => {
    const { files } = open(await render({}));
    const document = files["note.md"];
    expect(document === undefined ? "" : strFromU8(document)).toBe("# Quarterly Plan\n\nBODY\n");
  });

  it("records the manifest itself as a zero-byte index entry", async () => {
    const { manifest } = open(await render({}));
    expect(manifest.entries[0]).toEqual({ path: "manifest.json", kind: "manifest", bytes: 0 });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.note).toMatchObject({ noteId, workspaceId, pageSize: "a4" });
  });

  it("stops at the entry cap and records the remainder", async () => {
    // manifest + note.md already occupy two of the four slots.
    const artifact = await render({
      source: source({ options: options({ includeAttachments: true }) }),
      bundle: bundle({
        attachments: [
          attachment({ attachmentId: "a1", filename: "one.pdf" }),
          attachment({ attachmentId: "a2", filename: "two.pdf" }),
          attachment({ attachmentId: "a3", filename: "three.pdf" }),
        ],
      }),
      bounds: bounds({ maxEntries: 4 }),
    });
    const { files, manifest } = open(artifact);
    expect(Object.keys(files).sort()).toEqual([
      "attachments/one.pdf",
      "attachments/two.pdf",
      "manifest.json",
      "note.md",
    ]);
    expect(manifest.skipped).toEqual([
      { kind: "attachment", id: "a3", name: "three.pdf", reason: "entry_limit" },
    ]);
  });

  it("records the total byte cap and still returns a valid archive", async () => {
    const artifact = await render({
      source: source({ options: options({ includeAttachments: true }) }),
      bundle: bundle({ attachments: [attachment({ sizeBytes: 4096 })] }),
      bounds: bounds({ maxTotalBytes: 64 }),
    });
    const { files, manifest } = open(artifact);
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "note.md"]);
    expect(manifest.skipped.map((skip) => skip.reason)).toEqual(["total_limit"]);
  });

  it("skips an oversized attachment without failing the archive", async () => {
    const artifact = await render({
      source: source({ options: options({ includeAttachments: true }) }),
      bundle: bundle({
        attachments: [
          attachment({ attachmentId: "a1", filename: "small.pdf", sizeBytes: 8 }),
          attachment({ attachmentId: "a2", filename: "huge.pdf", sizeBytes: 5_000 }),
          attachment({ attachmentId: "a3", filename: "also-small.pdf", sizeBytes: 8 }),
        ],
      }),
      bounds: bounds({ maxAttachmentBytes: 1_000 }),
    });
    const { files, manifest } = open(artifact);
    expect(Object.keys(files).sort()).toEqual([
      "attachments/also-small.pdf",
      "attachments/small.pdf",
      "manifest.json",
      "note.md",
    ]);
    expect(manifest.skipped).toEqual([
      { kind: "attachment", id: "a2", name: "huge.pdf", reason: "oversized" },
    ]);
  });

  it("records an attachment whose bytes cannot be read as unreadable", async () => {
    const artifact = await render({
      source: source({ options: options({ includeAttachments: true }) }),
      bundle: bundle({
        attachments: [
          attachment({ attachmentId: "a1", filename: "gone.pdf" }),
          attachment({ attachmentId: "a2", filename: "keyless.pdf", objectKey: null }),
        ],
      }),
      readAttachment: () => Promise.resolve(null),
    });
    const { files, manifest } = open(artifact);
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "note.md"]);
    expect(manifest.skipped.map((skip) => skip.reason)).toEqual(["unreadable", "unreadable"]);
  });

  it("stops between entries when aborted and still returns a valid archive", async () => {
    const controller = new AbortController();
    const artifact = await render({
      source: source({ options: options({ includeAttachments: true, includeComments: true }) }),
      bundle: bundle({
        attachments: [
          attachment({ attachmentId: "a1", filename: "one.pdf" }),
          attachment({ attachmentId: "a2", filename: "two.pdf" }),
        ],
      }),
      readAttachment: () => {
        controller.abort();
        return Promise.resolve(Buffer.alloc(8, 0x41));
      },
      signal: controller.signal,
    });
    const { files, manifest } = open(artifact);
    expect(Object.keys(files).sort()).toEqual(["attachments/one.pdf", "manifest.json", "note.md"]);
    expect(manifest.skipped.map((skip) => `${skip.id}:${skip.reason}`)).toEqual([
      "a2:aborted",
      "comments:aborted",
    ]);
  });

  it("sanitizes hostile filenames and de-duplicates within the archive", async () => {
    const artifact = await render({
      source: source({ options: options({ includeAttachments: true }) }),
      bundle: bundle({
        attachments: [
          attachment({ attachmentId: "a1", filename: "report.pdf" }),
          attachment({ attachmentId: "a2", filename: "report.pdf" }),
          attachment({ attachmentId: "a3", filename: "../../etc/passwd" }),
          attachment({ attachmentId: "a4", filename: "C:\\Windows\\evil.pdf" }),
        ],
      }),
    });
    const paths = Object.keys(open(artifact).files).sort();
    expect(paths).toEqual([
      "attachments/evil.pdf",
      "attachments/passwd",
      "attachments/report (2).pdf",
      "attachments/report.pdf",
      "manifest.json",
      "note.md",
    ]);
    for (const path of paths) {
      expect(path.includes("..")).toBe(false);
      expect(path.startsWith("/")).toBe(false);
      expect(path.includes("\\")).toBe(false);
    }
  });

  it("caps comment and version counts and records why", async () => {
    const artifact = await render({
      source: source({
        options: options({ includeComments: true, includeVersionHistory: true }),
      }),
      bundle: bundle({
        comments: [comment("c1"), comment("c2"), comment("c3")],
        versions: [versionRow(3), versionRow(2), versionRow(1)],
      }),
      bounds: bounds({ maxComments: 1, maxVersions: 2 }),
    });
    const { files, manifest } = open(artifact);
    expect(readJson(files, "comments.json")).toHaveLength(1);
    expect(readJson(files, "versions.json")).toHaveLength(2);
    expect(manifest.skipped).toEqual([
      { kind: "comment", id: "comments", name: "comments.json", reason: "count_limit" },
      { kind: "version", id: "versions", name: "versions.json", reason: "count_limit" },
    ]);
  });

  it("carries the zip media facts", async () => {
    const artifact = await render({});
    expect(artifact.mimeType).toBe("application/zip");
    expect(artifact.fileExtension).toBe("zip");
  });

  it("passes the smaller of the per-attachment and remaining-total budget to the reader", async () => {
    const readAttachment = reader();
    await render({
      source: source({ options: options({ includeAttachments: true }) }),
      readAttachment,
      bounds: bounds({ maxAttachmentBytes: 1_000, maxTotalBytes: 500 }),
    });
    const maxBytes = readAttachment.mock.calls[0]?.[1];
    expect(maxBytes).toBeLessThanOrEqual(500);
  });
});
