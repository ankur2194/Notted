import { describe, expect, it, vi } from "vitest";

import { createAttachmentDirectory, documentHasImage } from "./attachment-directory";

import type { AttachmentEntry } from "./attachment-directory";

const ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";

function entry(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attachmentId: ATTACHMENT_ID,
    displayName: "chart.png",
    status: "ready",
    width: 1200,
    height: 800,
    blurDataUri: "data:image/webp;base64,AAAA",
    sources: {
      full: "http://localhost:3001/api/v1/workspaces/w/attachments/a/content?variant=full",
      medium: "http://localhost:3001/api/v1/workspaces/w/attachments/a/content?variant=medium",
      thumbnail:
        "http://localhost:3001/api/v1/workspaces/w/attachments/a/content?variant=thumbnail",
    },
    ...overrides,
  };
}

describe("attachment directory", () => {
  it("resolves unknown before anything has loaded", () => {
    // Never `missing`: an unavailable list is not evidence that an attachment
    // was deleted, and claiming otherwise would tell the reader a lie.
    expect(createAttachmentDirectory().resolve(ATTACHMENT_ID)).toEqual({ kind: "unknown" });
  });

  it("resolves a loaded attachment and reports a genuinely absent one as missing", () => {
    const directory = createAttachmentDirectory([entry()]);
    expect(directory.resolve(ATTACHMENT_ID)).toEqual({ kind: "ready", entry: entry() });
    expect(directory.resolve("00000000-0000-4000-8000-000000000000")).toEqual({ kind: "missing" });
  });

  it("returns to unknown when the list becomes unavailable again", () => {
    const directory = createAttachmentDirectory([entry()]);
    directory.setEntries(null);
    expect(directory.resolve(ATTACHMENT_ID).kind).toBe("unknown");
  });

  it("upserts a freshly uploaded attachment even before any listing landed", () => {
    // The upload path seeds the directory *before* the swap, so the node view
    // has the blur placeholder and the intrinsic size at mount and never flashes.
    const directory = createAttachmentDirectory();
    directory.upsert(entry());
    expect(directory.resolve(ATTACHMENT_ID).kind).toBe("ready");
  });

  it("replaces an existing entry rather than duplicating it", () => {
    const directory = createAttachmentDirectory([entry()]);
    directory.upsert(entry({ displayName: "renamed.png" }));
    const resolution = directory.resolve(ATTACHMENT_ID);
    expect(resolution.kind === "ready" ? resolution.entry.displayName : null).toBe("renamed.png");
  });

  it("notifies subscribers on every change and stops after unsubscribing", () => {
    const directory = createAttachmentDirectory();
    const listener = vi.fn();
    const unsubscribe = directory.subscribe(listener);

    directory.setEntries([entry()]);
    directory.upsert(entry({ displayName: "again.png" }));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    directory.setEntries(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("documentHasImage", () => {
  it("finds an image at any depth", () => {
    expect(
      documentHasImage({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "x" }] },
          {
            type: "blockquote",
            content: [{ type: "image", attrs: { attachmentId: ATTACHMENT_ID, alt: "" } }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("is false for a note with no images, so opening one fetches nothing", () => {
    expect(
      documentHasImage({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "no images here" }] }],
      }),
    ).toBe(false);
    expect(documentHasImage(null)).toBe(false);
    expect(documentHasImage("image")).toBe(false);
    expect(documentHasImage(undefined)).toBe(false);
  });
});
