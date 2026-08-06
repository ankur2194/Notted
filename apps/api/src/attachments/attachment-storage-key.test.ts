import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_OBJECT_KEY_PATTERN,
  attachmentObjectExtension,
  buildAttachmentObjectKey,
  parseAttachmentObjectKey,
} from "./attachment-storage-key";

const workspaceId = "20000000-0000-4000-8100-000000000001";
const attachmentId = "20000000-0000-4000-8900-000000000001";

describe("attachment object keys", () => {
  it("builds a canonical key that parses back to its parts", () => {
    const key = buildAttachmentObjectKey({
      workspaceId,
      attachmentId,
      variant: "thumbnail",
      extension: ".webp",
    });
    expect(key).toMatch(ATTACHMENT_OBJECT_KEY_PATTERN);
    expect(key.startsWith(`w/${workspaceId}/a/${attachmentId}/thumbnail/`)).toBe(true);
    expect(parseAttachmentObjectKey(key)).toMatchObject({
      workspaceId,
      attachmentId,
      variant: "thumbnail",
      extension: ".webp",
    });
  });

  it("uppercases are normalized so a key is byte-stable for one resource pair", () => {
    const key = buildAttachmentObjectKey({
      workspaceId: workspaceId.toUpperCase(),
      attachmentId: attachmentId.toUpperCase(),
      variant: "original",
      extension: ".png",
    });
    expect(parseAttachmentObjectKey(key)?.workspaceId).toBe(workspaceId);
  });

  it("refuses non-UUID identifiers, unknown variants, and unknown extensions", () => {
    expect(() =>
      buildAttachmentObjectKey({
        workspaceId: "../../etc",
        attachmentId,
        variant: "original",
        extension: ".png",
      }),
    ).toThrow("UUID workspaceId");
    expect(() =>
      buildAttachmentObjectKey({
        workspaceId,
        attachmentId: "not-a-uuid",
        variant: "original",
        extension: ".png",
      }),
    ).toThrow("UUID attachmentId");
    expect(() =>
      buildAttachmentObjectKey({
        workspaceId,
        attachmentId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        variant: "huge" as any,
        extension: ".png",
      }),
    ).toThrow("known variant");
    expect(() =>
      buildAttachmentObjectKey({
        workspaceId,
        attachmentId,
        variant: "original",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extension: ".php" as any,
      }),
    ).toThrow("known extension");
  });

  it("generates a fresh 32-hex token per object so keys are unguessable and immutable", () => {
    const keys = new Set(
      Array.from({ length: 64 }, () =>
        buildAttachmentObjectKey({
          workspaceId,
          attachmentId,
          variant: "original",
          extension: ".jpg",
        }),
      ),
    );
    expect(keys.size).toBe(64);
    for (const key of keys) {
      expect(parseAttachmentObjectKey(key)?.token).toMatch(/^[\da-f]{32}$/u);
    }
  });

  it("returns null for keys outside the canonical layout", () => {
    for (const key of [
      "",
      `w/${workspaceId}/a/${attachmentId}/original/short.jpg`,
      `x/${workspaceId}/a/${attachmentId}/original/${"a".repeat(32)}.jpg`,
      `w/${workspaceId}/${attachmentId}/original/${"a".repeat(32)}.jpg`,
      `w/${workspaceId}/a/${attachmentId}/evil/${"a".repeat(32)}.jpg`,
      `w/${workspaceId}/a/${attachmentId}/original/${"a".repeat(32)}.php`,
      `w/${workspaceId}/a/${attachmentId}/original/${"a".repeat(32)}.jpg/../secret`,
    ]) {
      expect(parseAttachmentObjectKey(key)).toBeNull();
    }
  });

  it("maps stored MIME types to canonical extensions and falls back to .bin", () => {
    expect(attachmentObjectExtension("image/jpeg")).toBe(".jpg");
    expect(attachmentObjectExtension("IMAGE/PNG")).toBe(".png");
    expect(attachmentObjectExtension("image/gif")).toBe(".gif");
    expect(attachmentObjectExtension("image/webp")).toBe(".webp");
    expect(attachmentObjectExtension("image/svg+xml")).toBe(".svg");
    expect(attachmentObjectExtension("image/heic")).toBe(".bin");
    expect(attachmentObjectExtension("application/x-httpd-php")).toBe(".bin");
  });

  it("is never imported by the authorization module (a key is not an authority)", () => {
    const directory = join(__dirname, "..", "authorization");
    const offenders = readdirSync(directory)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        readFileSync(join(directory, name), "utf8").includes("attachment-storage-key"),
      );
    expect(offenders).toEqual([]);
  });
});
