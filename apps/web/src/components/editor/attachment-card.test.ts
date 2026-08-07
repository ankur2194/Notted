import { describe, expect, it } from "vitest";

import { createAttachmentDirectory } from "./attachment-directory";
import {
  ATTACHMENT_KIND_LABELS,
  attachmentIconKind,
  createAttachmentIcon,
} from "./attachment-icons";
import { attachmentFilesFromDataTransfer, isAttachmentCandidate } from "./attachment-transfer";
import {
  ATTACHMENT_DOWNLOAD_LABEL,
  ATTACHMENT_FAILED_TEXT,
  ATTACHMENT_LOADING_TEXT,
  ATTACHMENT_PREVIEWABLE_MIME_TYPES,
  ATTACHMENT_UNAVAILABLE_TEXT,
  createAttachmentDom,
  formatAttachmentDate,
  paintAttachment,
} from "./extensions/CustomAttachment";

import type { AttachmentEntry } from "./attachment-directory";
import type { AttachmentDom } from "./extensions/CustomAttachment";
import type { DataTransferLike } from "./image-transfer";

const ATTACHMENT_ID = "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CONTENT_URL = `https://api.test/api/v1/workspaces/w/attachments/${ATTACHMENT_ID}/content?variant=full`;

/**
 * A stand-in for a ProseMirror node.
 *
 * `paintAttachment` reads `node.attrs` and nothing else, so a literal is a
 * complete and honest double here — building a real schema would test TipTap's
 * node construction rather than the painting rules under test.
 */
function node(attrs: Record<string, unknown> = {}) {
  return {
    attrs: {
      attachmentId: ATTACHMENT_ID,
      name: "quarterly-report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 245_760,
      ...attrs,
    },
  } as unknown as Parameters<typeof paintAttachment>[1];
}

function entry(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attachmentId: ATTACHMENT_ID,
    displayName: "quarterly-report.pdf",
    status: "ready",
    mediaType: "file",
    mimeType: "application/pdf",
    sizeBytes: 245_760,
    createdAt: "2026-01-12T09:30:00.000Z",
    contentUrl: CONTENT_URL,
    width: null,
    height: null,
    blurDataUri: null,
    sources: { full: CONTENT_URL, medium: CONTENT_URL, thumbnail: CONTENT_URL },
    ...overrides,
  };
}

function paint(
  overrides: {
    entry?: AttachmentEntry | null;
    editable?: boolean;
    attrs?: Record<string, unknown>;
  } = {},
): AttachmentDom {
  const dom = createAttachmentDom();
  const directory =
    overrides.entry === null
      ? null
      : createAttachmentDirectory(overrides.entry === undefined ? [] : [overrides.entry]);
  paintAttachment(dom, node(overrides.attrs), {
    directory,
    editable: overrides.editable ?? true,
  });
  return dom;
}

describe("attachment card rendering", () => {
  it("shows the file, enables the download, and offers a preview when ready", () => {
    const dom = paint({ entry: entry() });

    expect(dom.root.getAttribute("data-attachment-state")).toBe("ready");
    expect(dom.root.getAttribute("data-attachment-id")).toBe(ATTACHMENT_ID);
    expect(dom.root.getAttribute("aria-busy")).toBe("false");
    expect(dom.name.textContent).toBe("quarterly-report.pdf");
    expect(dom.detail.textContent).toContain("PDF document");
    expect(dom.detail.textContent).toContain("240 KiB");
    expect(dom.status.textContent).toBe("");

    expect(dom.download.getAttribute("href")).toBe(CONTENT_URL);
    expect(dom.download.hasAttribute("aria-disabled")).toBe(false);
    expect(dom.download.tabIndex).toBe(0);
    expect(dom.download.getAttribute("aria-label")).toBe(
      `${ATTACHMENT_DOWNLOAD_LABEL} quarterly-report.pdf`,
    );
    // PDF is the one previewable type, so the button is offered here.
    expect(ATTACHMENT_PREVIEWABLE_MIME_TYPES.has("application/pdf")).toBe(true);
    expect(dom.preview.hidden).toBe(false);
  });

  it("hides the preview for a type the in-app viewer cannot render", () => {
    const dom = paint({
      attrs: { mimeType: "application/zip", name: "bundle.zip" },
      entry: entry({ mimeType: "application/zip", displayName: "bundle.zip" }),
    });
    expect(dom.preview.hidden).toBe(true);
    // A download is still offered: not previewable is not the same as not usable.
    expect(dom.download.getAttribute("href")).toBe(CONTENT_URL);
  });

  it("says details are loading, and never that the file is gone, before metadata arrives", () => {
    // The critical distinction: an unavailable listing is NOT evidence that an
    // attachment was deleted, so an unresolved card must never claim it was.
    const dom = paint({ entry: null });

    expect(dom.root.getAttribute("data-attachment-state")).toBe("unknown");
    expect(dom.root.getAttribute("aria-busy")).toBe("true");
    expect(dom.status.textContent).toBe(ATTACHMENT_LOADING_TEXT);
    expect(dom.status.textContent).not.toBe(ATTACHMENT_UNAVAILABLE_TEXT);
    // The node's cached name is still shown, so the card is never blank.
    expect(dom.name.textContent).toBe("quarterly-report.pdf");
    // No bytes may be requested for something not yet known to exist.
    expect(dom.download.hasAttribute("href")).toBe(false);
    expect(dom.download.getAttribute("aria-disabled")).toBe("true");
    expect(dom.download.tabIndex).toBe(-1);
  });

  it("says the file is unavailable once metadata has loaded without it", () => {
    const dom = paint();

    expect(dom.root.getAttribute("data-attachment-state")).toBe("missing");
    expect(dom.status.textContent).toBe(ATTACHMENT_UNAVAILABLE_TEXT);
    expect(dom.download.hasAttribute("href")).toBe(false);
    expect(dom.preview.hidden).toBe(true);
  });

  it("reports a failed attachment and offers no download for bytes that do not exist", () => {
    const dom = paint({ entry: entry({ status: "failed" }) });

    expect(dom.root.getAttribute("data-attachment-state")).toBe("failed");
    expect(dom.status.textContent).toBe(ATTACHMENT_FAILED_TEXT);
    expect(dom.download.hasAttribute("href")).toBe(false);
    expect(dom.preview.hidden).toBe(true);
  });

  it("lets the authorized directory override the node's cached projection", () => {
    // The node holds a snapshot taken at insertion; the directory is the
    // authorized projection of the row and wins wherever it has an opinion.
    const dom = paint({
      entry: entry({ displayName: "renamed.pdf", sizeBytes: 1_048_576 }),
    });
    expect(dom.name.textContent).toBe("renamed.pdf");
    expect(dom.detail.textContent).toContain("1 MiB");
  });

  it("renders no card for a node whose attributes do not validate", () => {
    const dom = paint({ attrs: { attachmentId: "not-a-uuid" }, entry: entry() });
    expect(dom.root.getAttribute("data-attachment-state")).toBe("missing");
    expect(dom.root.hasAttribute("data-attachment-id")).toBe(false);
    expect(dom.actions.hidden).toBe(true);
  });

  it("hides delete from a reader who cannot edit, and keeps download", () => {
    const readOnly = paint({ entry: entry(), editable: false });
    expect(readOnly.remove.hidden).toBe(true);
    expect(readOnly.download.getAttribute("href")).toBe(CONTENT_URL);

    const editable = paint({ entry: entry(), editable: true });
    expect(editable.remove.hidden).toBe(false);
  });
});

describe("attachment card accessibility", () => {
  it("gives assistive technology the untruncated name, kind, exact size, and date", () => {
    const dom = paint({ entry: entry() });
    const announced = dom.fullName.textContent ?? "";

    expect(announced).toContain("quarterly-report.pdf");
    expect(announced).toContain("PDF document");
    // The EXACT byte count, not the rounded one a sighted reader sees.
    expect(announced).toContain("245,760 bytes");
    expect(announced).toContain("uploaded 12 January 2026");
    expect(dom.root.getAttribute("aria-label")).toBe(announced);
    // The visible detail line duplicates it, so it is hidden from the tree.
    expect(dom.detail.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the card as one group and its status politely", () => {
    const dom = paint({ entry: entry() });
    expect(dom.root.getAttribute("role")).toBe("group");
    expect(dom.root.getAttribute("contenteditable")).toBe("false");
    expect(dom.status.getAttribute("role")).toBe("status");
    expect(dom.status.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps every control operable from the keyboard and names each one", () => {
    const dom = paint({ entry: entry() });
    // Real buttons and a real anchor: focusable, activatable by Enter/Space,
    // and reachable in the tab order without any custom key handling.
    expect(dom.preview.tagName).toBe("BUTTON");
    expect(dom.remove.tagName).toBe("BUTTON");
    expect(dom.download.tagName).toBe("A");
    expect(dom.preview.type).toBe("button");
    expect(dom.remove.type).toBe("button");
    for (const control of [dom.download, dom.preview, dom.remove]) {
      expect(control.getAttribute("aria-label")).toContain("quarterly-report.pdf");
    }
  });

  it("marks the action row as chrome so it never prints or exports", () => {
    const dom = paint({ entry: entry() });
    expect(dom.actions.hasAttribute("data-notted-print-hide")).toBe(true);
  });

  it("carries no URL-shaped attribute anywhere on the card element itself", () => {
    // The card resolves bytes through the directory. The only URL in the DOM is
    // the anchor's `href`, which is an authorized API route built at paint time
    // and never stored on the node.
    const dom = paint({ entry: entry() });
    // `NamedNodeMap` is not iterable in the DOM typings, so it is materialised.
    for (const attribute of Array.from(dom.root.attributes)) {
      expect(["src", "url", "href", "data-src", "data-url"]).not.toContain(attribute.name);
    }
  });
});

describe("attachment icons", () => {
  it.each([
    ["application/pdf", "report.pdf", "pdf"],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "budget.xlsx",
      "spreadsheet",
    ],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "memo.docx",
      "document",
    ],
    ["application/rtf", "memo.rtf", "document"],
    ["application/zip", "bundle.zip", "archive"],
    ["application/gzip", "logs.tar.gz", "archive"],
    // Text and code all store as `text/plain`, so the extension decides.
    ["text/plain", "main.py", "code"],
    ["text/plain", "data.csv", "spreadsheet"],
    ["text/plain", "notes.txt", "text"],
  ])("classifies %s named %s", (mimeType, name, expected) => {
    expect(attachmentIconKind(mimeType, name)).toBe(expected);
  });

  it("builds a decorative SVG with no markup parsing and a readable label", () => {
    const icon = createAttachmentIcon("pdf");
    expect(icon.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(icon.innerHTML).not.toContain("<script");
    expect(ATTACHMENT_KIND_LABELS.pdf).toBe("PDF document");
  });
});

describe("attachment date formatting", () => {
  it("formats a valid timestamp and returns an empty string otherwise", () => {
    expect(formatAttachmentDate("2026-01-12T09:30:00.000Z")).toBe("12 January 2026");
    expect(formatAttachmentDate(null)).toBe("");
    expect(formatAttachmentDate("")).toBe("");
    expect(formatAttachmentDate("not a date")).toBe("");
  });
});

describe("attachment transfer filtering", () => {
  const file = (name: string, type: string): File =>
    new File([new Uint8Array([1, 2, 3])], name, { type });

  it("accepts supported files and declines images, which the image plugin owns", () => {
    expect(isAttachmentCandidate(file("report.pdf", "application/pdf"))).toBe(true);
    expect(isAttachmentCandidate(file("main.py", ""))).toBe(true);
    expect(isAttachmentCandidate(file("photo.png", "image/png"))).toBe(false);
    expect(isAttachmentCandidate(file("installer.exe", "application/x-msdownload"))).toBe(false);
  });

  it("reads only supported files out of a transfer", () => {
    const transfer: DataTransferLike = {
      files: [file("report.pdf", "application/pdf"), file("photo.png", "image/png")],
    };
    expect(attachmentFilesFromDataTransfer(transfer).map((item) => item.name)).toEqual([
      "report.pdf",
    ]);
  });
});
