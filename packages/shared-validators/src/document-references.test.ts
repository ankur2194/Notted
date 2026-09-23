import { describe, expect, it } from "vitest";

import { documentReferencesAttachment } from "./index";

const fileId = "30000000-0000-4000-8000-000000000001";
const imageId = "30000000-0000-4000-8000-000000000002";
const file = {
  type: "attachment",
  attrs: { attachmentId: fileId, name: "notes.txt", mimeType: "text/plain", sizeBytes: 7 },
};
const image = { type: "image", attrs: { attachmentId: imageId, alt: "Diagram" } };

describe("documentReferencesAttachment", () => {
  const document = {
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: fileId }] }],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [file] }],
          },
        ],
      },
      image,
    ],
  };

  it("recognizes only current, correctly typed references even when nested", () => {
    expect(documentReferencesAttachment(document, fileId, "file")).toBe(true);
    expect(documentReferencesAttachment(document, imageId, "image")).toBe(true);
    expect(documentReferencesAttachment(document, fileId, "image")).toBe(false);
    expect(documentReferencesAttachment(document, imageId, "file")).toBe(false);
    expect(
      documentReferencesAttachment(document, "30000000-0000-4000-8000-000000000003", "file"),
    ).toBe(false);
    const missing = { type: "doc", content: [image] };
    expect(documentReferencesAttachment(missing, fileId, "file")).toBe(false);
  });

  it("does not follow text, unknown nodes or misleading attributes", () => {
    expect(
      documentReferencesAttachment(
        {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: fileId }] }],
        },
        fileId,
        "file",
      ),
    ).toBe(false);
    const unknown = { type: "doc", content: [{ type: "unknown", content: [file] }] };
    const forged = {
      type: "doc",
      content: [{ ...file, attrs: { ...file.attrs, url: "https://evil.test" } }],
    };
    expect(documentReferencesAttachment(unknown, fileId, "file")).toBe(false);
    expect(documentReferencesAttachment(forged, fileId, "file")).toBe(false);
    expect(
      documentReferencesAttachment(
        { type: "doc", content: [{ ...image, attrs: { ...image.attrs, attachmentId: fileId } }] },
        fileId,
        "file",
      ),
    ).toBe(false);
    expect(
      documentReferencesAttachment(
        { type: "doc", content: [{ ...file, attrs: { ...file.attrs, attachmentId: imageId } }] },
        imageId,
        "image",
      ),
    ).toBe(false);
  });

  it("fails closed on malformed, oversized, cyclic or invalid-id input", () => {
    expect(documentReferencesAttachment(null, fileId, "file")).toBe(false);
    const malformed = { type: "doc", content: [file, { type: "image", attrs: {} }] };
    const oversized = {
      type: "doc",
      content: [file, ...Array.from({ length: 2_100 }, () => ({ type: "paragraph" }))],
    };
    expect(documentReferencesAttachment(malformed, fileId, "file")).toBe(false);
    expect(documentReferencesAttachment(oversized, fileId, "file")).toBe(false);
    const cycle: { type: string; content?: unknown[] } = { type: "doc" };
    cycle.content = [cycle];
    expect(documentReferencesAttachment(cycle, fileId, "file")).toBe(false);
    expect(documentReferencesAttachment(document, "invalid", "file")).toBe(false);
    const throwing = { type: "doc", content: [file] };
    Object.defineProperty(throwing, "content", {
      get: () => {
        throw new Error("bad input");
      },
    });
    expect(documentReferencesAttachment(throwing, fileId, "file")).toBe(false);
    let reads = 0;
    const switching = { type: "doc" } as { type: string; content?: unknown[] };
    Object.defineProperty(switching, "content", {
      get: () => (++reads === 1 ? [] : [file]),
    });
    expect(documentReferencesAttachment(switching, fileId, "file")).toBe(false);
  });
});
