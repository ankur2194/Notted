// Part 45 — the single answer to "which objects does this attachment row own?".
//
// Both the delete path and the maintenance sweeps ask this function, and the
// failure mode of a missed key is bytes that no sweep can ever attribute to a
// row again. So the two rules are pinned here: every object-bearing slot is
// included (a SUPERSET of the key-buildable variant vocabulary), and nothing
// that is not an object key ever is.

import { describe, expect, it } from "vitest";

import { attachmentObjectKeys } from "./attachment-object-keys";
import { ATTACHMENT_VARIANT_NAMES } from "./attachment-storage-key";

import type { AttachmentVariantRecord } from "../database/schema";

const workspaceId = "70000000-0000-4000-8100-000000000001";
const attachmentId = "70000000-0000-4000-8900-000000000001";

function key(variant: string, seed: string, extension = ".webp"): string {
  return `w/${workspaceId}/a/${attachmentId}/${variant}/${seed.repeat(32).slice(0, 32)}${extension}`;
}

const ORIGINAL = key("original", "a", ".png");
const FULL = key("full", "b");
const MEDIUM = key("medium", "c");
const THUMBNAIL = key("thumbnail", "d");
const PREVIEW = key("preview", "e");

function imageVariant(objectKey: string) {
  return { key: objectKey, width: 10, height: 10, bytes: 128, mimeType: "image/webp" };
}

/** A fully processed image row, as Part 41 leaves it. */
function fullRecord(): AttachmentVariantRecord {
  return {
    original: { ...imageVariant(ORIGINAL), mimeType: "image/png" },
    full: imageVariant(FULL),
    medium: imageVariant(MEDIUM),
    thumbnail: imageVariant(THUMBNAIL),
    preview: { key: PREVIEW, mimeType: "image/webp", width: 4, height: 4 },
    blur: { dataUri: "data:image/webp;base64,UklGRgAAAA==", width: 4, height: 4 },
  };
}

describe("attachmentObjectKeys", () => {
  it("returns every object-bearing variant, in a fixed order", () => {
    expect(attachmentObjectKeys(fullRecord(), ORIGINAL)).toEqual([
      ORIGINAL,
      FULL,
      MEDIUM,
      THUMBNAIL,
      PREVIEW,
    ]);
  });

  it("covers Part 44's preview, which is NOT in the key-buildable vocabulary", () => {
    // The module comment requires this list to stay a SUPERSET of
    // `ATTACHMENT_VARIANT_NAMES`. `preview` is the slot that makes it strict, so
    // a parser-driven implementation would silently strand its bytes.
    expect([...ATTACHMENT_VARIANT_NAMES]).not.toContain("preview");
    expect(attachmentObjectKeys(fullRecord(), null)).toContain(PREVIEW);

    // Every key-buildable variant is still covered, one slot at a time. The
    // name list below is compared to `ATTACHMENT_VARIANT_NAMES`, so introducing
    // a new variant fails here instead of stranding its bytes in silence.
    const perVariant: readonly (readonly [string, AttachmentVariantRecord])[] = [
      ["original", { original: imageVariant(key("original", "f")) }],
      ["full", { full: imageVariant(key("full", "f")) }],
      ["medium", { medium: imageVariant(key("medium", "f")) }],
      ["thumbnail", { thumbnail: imageVariant(key("thumbnail", "f")) }],
    ];
    expect(perVariant.map(([name]) => name)).toEqual([...ATTACHMENT_VARIANT_NAMES]);
    for (const [name, record] of perVariant) {
      expect(attachmentObjectKeys(record, null)).toEqual([key(name, "f")]);
    }
  });

  it("NEVER returns the blur placeholder, which is an inline data URI", () => {
    const keys = attachmentObjectKeys(fullRecord(), ORIGINAL);
    expect(keys.join("|")).not.toContain("data:");
    expect(keys).toHaveLength(5);

    // A row whose ONLY variant is a blur owns no objects at all.
    const blurOnly: AttachmentVariantRecord = {
      blur: { dataUri: "data:image/webp;base64,UklGRgAAAA==", width: 4, height: 4 },
    };
    expect(attachmentObjectKeys(blurOnly, null)).toEqual([]);
  });

  it("includes storage_key for an in-flight row whose variants are still empty", () => {
    // This is exactly the row the abandoned-upload sweep reclaims: the original
    // object may already exist while `variants` is `{}`.
    expect(attachmentObjectKeys({}, ORIGINAL)).toEqual([ORIGINAL]);
    expect(attachmentObjectKeys(null, ORIGINAL)).toEqual([ORIGINAL]);
  });

  it("de-duplicates storage_key against variants.original.key", () => {
    // For a `ready` row the two are the same object; counting it twice would
    // make every removal count and every report double.
    const keys = attachmentObjectKeys(fullRecord(), ORIGINAL);
    expect(keys.filter((value) => value === ORIGINAL)).toHaveLength(1);

    // A row whose `storage_key` still points at a superseded original keeps
    // BOTH, so reprocessing cannot strand the old bytes.
    const superseded = key("original", "9", ".png");
    const keysWithSuperseded = attachmentObjectKeys(fullRecord(), superseded);
    expect(keysWithSuperseded[0]).toBe(superseded);
    expect(keysWithSuperseded).toContain(ORIGINAL);
    expect(keysWithSuperseded).toHaveLength(6);
  });

  it("treats an absent, null, or empty storage key as no key", () => {
    expect(attachmentObjectKeys({}, null)).toEqual([]);
    expect(attachmentObjectKeys({}, undefined)).toEqual([]);
    expect(attachmentObjectKeys({}, "")).toEqual([]);
    expect(attachmentObjectKeys(null, null)).toEqual([]);
    expect(attachmentObjectKeys({})).toEqual([]);
  });

  it("ignores a corrupt variant entry rather than handing storage a bad key", () => {
    const corrupt = {
      original: { key: "", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
      full: { width: 1, height: 1, bytes: 1, mimeType: "image/webp" },
      medium: null,
      thumbnail: { key: 42, width: 1, height: 1, bytes: 1, mimeType: "image/webp" },
      preview: { key: THUMBNAIL, mimeType: "image/webp", width: 1, height: 1 },
    } as unknown as AttachmentVariantRecord;

    // Only the one well-formed key survives; an empty string or a non-string
    // would otherwise be sent to the object store as a delete target.
    expect(attachmentObjectKeys(corrupt, null)).toEqual([THUMBNAIL]);
  });

  it("returns a frozen array, so a caller cannot mutate a row's key set", () => {
    const keys = attachmentObjectKeys(fullRecord(), ORIGINAL);
    expect(Object.isFrozen(keys)).toBe(true);
  });
});
