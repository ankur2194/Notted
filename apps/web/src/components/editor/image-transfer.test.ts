import { MAX_IMAGE_UPLOAD_BYTES } from "@notted/shared-validators";
import { describe, expect, it, vi } from "vitest";

import {
  IMAGE_UPLOAD_ACCEPT,
  createObjectUrlRegistry,
  hasImageFiles,
  hasMeaningfulHtml,
  imageFilesFromDataTransfer,
} from "./image-transfer";

import type { DataTransferItemLike, DataTransferLike } from "./image-transfer";

function file(name: string, type: string, size = 1_024): File {
  const blob = new File([new Uint8Array(Math.min(size, 32))], name, { type });
  Object.defineProperty(blob, "size", { value: size });
  return blob;
}

function item(file: File | null, type: string, kind = "file"): DataTransferItemLike {
  return { kind, type, getAsFile: () => file };
}

function transfer(overrides: Partial<DataTransferLike>): DataTransferLike {
  return { items: null, files: null, types: null, ...overrides };
}

describe("image extraction from a transfer payload", () => {
  it("reads image files from items, in payload order", () => {
    const first = file("a.png", "image/png");
    const second = file("b.jpg", "image/jpeg");
    const extracted = imageFilesFromDataTransfer(
      transfer({
        items: [item(first, "image/png"), item(second, "image/jpeg")],
      }),
    );
    expect(extracted).toEqual([first, second]);
  });

  it("skips non-file items, non-image types, and items that yield nothing", () => {
    const kept = file("k.webp", "image/webp");
    const extracted = imageFilesFromDataTransfer(
      transfer({
        items: [
          item(null, "text/plain", "string"),
          item(file("doc.pdf", "application/pdf"), "application/pdf"),
          item(null, "image/png"),
          item(kept, "image/webp"),
        ],
      }),
    );
    expect(extracted).toEqual([kept]);
  });

  it("falls back to the files list when items carry nothing", () => {
    const dropped = file("drop.gif", "image/gif");
    expect(
      imageFilesFromDataTransfer(transfer({ items: [], files: [dropped, file("folder", "")] })),
    ).toEqual([dropped]);
  });

  it("accepts every MIME type the shared contract accepts", () => {
    for (const type of IMAGE_UPLOAD_ACCEPT.split(",")) {
      expect(
        imageFilesFromDataTransfer(transfer({ files: [file(`x.${type}`, type)] })),
      ).toHaveLength(1);
    }
  });

  it("returns nothing for a null payload", () => {
    expect(imageFilesFromDataTransfer(null)).toEqual([]);
    expect(hasImageFiles(null)).toBe(false);
    expect(hasMeaningfulHtml(null)).toBe(false);
  });
});

describe("drag affordance detection", () => {
  it("recognises an image item mid-drag, when the bytes are still withheld", () => {
    // The whole reason this predicate exists: `getAsFile()` returns null during
    // a drag, so the real extractor cannot answer the highlight question.
    expect(hasImageFiles(transfer({ items: [item(null, "image/png")] }))).toBe(true);
  });

  it("falls back to a generic Files entry when nothing else is exposed", () => {
    expect(hasImageFiles(transfer({ types: ["Files"] }))).toBe(true);
    expect(hasImageFiles(transfer({ types: ["text/plain"] }))).toBe(false);
  });
});

describe("meaningful HTML detection", () => {
  const withHtml = (html: string): DataTransferLike =>
    transfer({ types: ["text/html", "Files"], getData: () => html });

  it("treats a bare image wrapper as not meaningful, so the upload path wins", () => {
    expect(hasMeaningfulHtml(withHtml('<meta charset="utf-8"><img src="blob:x">'))).toBe(false);
    expect(hasMeaningfulHtml(withHtml('<div><img src="x"></div>'))).toBe(false);
    expect(hasMeaningfulHtml(withHtml("<!--StartFragment--><img><!--EndFragment-->"))).toBe(false);
  });

  it("treats a document containing text as meaningful, so the HTML paste wins", () => {
    // The Word case: an inline image plus real prose. Consuming this as an
    // upload would silently throw the document away.
    expect(
      hasMeaningfulHtml(withHtml('<p>Quarterly results</p><img src="file:///c/img.png">')),
    ).toBe(true);
  });

  it("treats structural markup with no text as meaningful", () => {
    expect(hasMeaningfulHtml(withHtml("<table><tr><td><img></td></tr></table>"))).toBe(true);
    expect(hasMeaningfulHtml(withHtml("<ul><li><img></li></ul>"))).toBe(true);
  });

  it("says no when the payload declares no HTML at all", () => {
    expect(hasMeaningfulHtml(transfer({ types: ["Files"], getData: () => "<p>x</p>" }))).toBe(
      false,
    );
    expect(hasMeaningfulHtml(transfer({ types: ["text/html"], getData: () => "" }))).toBe(false);
  });
});

describe("object URL registry", () => {
  it("creates one URL per key and reuses it", () => {
    const create = vi.fn(() => `blob:${create.mock.calls.length}`);
    const revoke = vi.fn();
    const registry = createObjectUrlRegistry(create, revoke);
    const blob = file("a.png", "image/png");

    const first = registry.create("one", blob);
    expect(registry.create("one", blob)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(registry.get("one")).toBe(first);
  });

  it("revokes exactly once however many times release is called", () => {
    const revoke = vi.fn();
    const registry = createObjectUrlRegistry(() => "blob:one", revoke);
    registry.create("one", file("a.png", "image/png"));

    // The three revoke sites — decoration destroy, unmount teardown, and the
    // successful swap — all funnel here, so a repeat must be inert.
    registry.release("one");
    registry.release("one");
    registry.releaseAll();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(registry.get("one")).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("releases everything on teardown", () => {
    const revoke = vi.fn();
    const registry = createObjectUrlRegistry((blob) => `blob:${blob.size}`, revoke);
    registry.create("a", file("a.png", "image/png", 10));
    registry.create("b", file("b.png", "image/png", 20));
    registry.releaseAll();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(0);
  });
});

describe("the accept list", () => {
  it("is exactly the shared contract's image types", () => {
    expect(IMAGE_UPLOAD_ACCEPT).toContain("image/png");
    expect(IMAGE_UPLOAD_ACCEPT).toContain("image/heic");
    expect(IMAGE_UPLOAD_ACCEPT).not.toContain("application/pdf");
    // Referenced so a drift in the shared ceiling shows up in this suite too.
    expect(MAX_IMAGE_UPLOAD_BYTES).toBeGreaterThan(0);
  });
});
