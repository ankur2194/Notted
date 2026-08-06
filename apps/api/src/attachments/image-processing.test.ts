import { describe, expect, it } from "vitest";

import { ATTACHMENT_PROCESSING_ERRORS } from "./attachments.constants";
import { ImageProcessingError, PassthroughImageProcessor } from "./image-processing";

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("PassthroughImageProcessor", () => {
  it("supports only formats a browser can already decode", () => {
    const processor = new PassthroughImageProcessor();
    for (const supported of ["image/jpeg", "image/png", "image/gif", "image/webp"] as const) {
      expect(processor.supports(supported)).toBe(true);
    }
    // The INERT seam implementation stays deliberately narrow: unit suites that
    // inject it are testing authorization, tenancy, and transaction ordering,
    // not decoding. Production SVG/HEIC support lives in `ImageProcessingService`
    // and is covered by `image-processing.service.test.ts`.
    expect(processor.supports("image/svg+xml")).toBe(false);
    expect(processor.supports("image/heic")).toBe(false);
  });

  it("exposes an input ceiling so the multipart parser can refuse before buffering", () => {
    expect(new PassthroughImageProcessor().maximumInputBytes).toBe(15 * 1_024 * 1_024);
  });

  it("emits exactly one byte-identical original variant and no derived renditions", async () => {
    const result = await new PassthroughImageProcessor().process({
      buffer: bytes,
      sniffed: "image/png",
    });
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]).toMatchObject({ variant: "original", mimeType: "image/png" });
    expect(result.objects[0]?.body.equals(bytes)).toBe(true);
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
    expect(result.blur).toBeNull();
  });

  it("rejects an unsupported format with a short stable code", async () => {
    await expect(
      new PassthroughImageProcessor().process({ buffer: bytes, sniffed: "image/svg+xml" }),
    ).rejects.toBeInstanceOf(ImageProcessingError);
    await expect(
      new PassthroughImageProcessor().process({ buffer: bytes, sniffed: "image/heic" }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.unsupportedMediaType });
  });

  it("never puts a raw exception message into the persisted error code", () => {
    for (const code of Object.values(ATTACHMENT_PROCESSING_ERRORS)) {
      expect(code).toMatch(/^[a-z_]{1,40}$/u);
    }
  });
});
