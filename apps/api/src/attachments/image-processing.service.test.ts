// Part 41: the format matrix Plan.md's Verify clause asks for.
//
// Every fixture is generated at test time by `test/image-fixtures.ts`; no binary
// is committed. Assertions about dimensions deliberately check BOUNDS and the
// aspect ratio rather than a locally recomputed exact number: libvips does not
// use one uniform rounding rule (a JPEG source may shrink-on-load by a power of
// two inside libjpeg first), so an exact expectation would encode a decoder
// implementation detail rather than the behaviour that matters. Where a fixture
// is small enough that `withoutEnlargement` forbids any resize, the dimensions
// ARE asserted exactly, because then they are decoder-independent.

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allRasterFixtures,
  alphaPngFixture,
  animatedGifFixture,
  animatedWebpFixture,
  decompressionBombPng,
  garbageBytes,
  HOSTILE_SVGS,
  jpegFixture,
  jpegWithGpsFixture,
  pngFixture,
  SAFE_SVG,
  staticGifFixture,
  truncatedJpeg,
  webpFixture,
} from "../../test/image-fixtures";
import { parseImageProcessingConfig } from "../config/image-processing.config";

import { ATTACHMENT_PROCESSING_ERRORS } from "./attachments.constants";
import { resetHeicConverter, setHeicConverter } from "./heic-decoder";
import { ImageProcessingService } from "./image-processing.service";
import {
  FULL_LONGEST_EDGE_PX,
  MAX_BLUR_DATA_URI_BYTES,
  MEDIUM_WIDTH_PX,
  THUMBNAIL_WIDTH_PX,
} from "./image-variants";

import type { ProcessedImage, ProcessedImageObject } from "./image-processing";
import type { ImageProcessingConfig } from "../config/image-processing.config";

/** Real defaults, parsed by the real parser, so the test cannot drift from prod. */
const DEFAULTS = parseImageProcessingConfig({});

function service(overrides: Partial<ImageProcessingConfig> = {}): ImageProcessingService {
  return new ImageProcessingService(Object.freeze({ ...DEFAULTS, ...overrides }));
}

function variant(result: ProcessedImage, name: string): ProcessedImageObject {
  const found = result.objects.find((object) => object.variant === name);
  if (found === undefined) throw new Error(`missing variant ${name}`);
  return found;
}

/**
 * Wall-clock budget for "rejected within resource limits". Loose on purpose:
 * under v8 coverage instrumentation the same work costs a variable multiple of
 * its uninstrumented time, and the assertion is that a decompression bomb is
 * refused promptly rather than expanded — not a latency SLO.
 */
const REJECTION_BUDGET_MS = 5_000;

afterEach(() => {
  resetHeicConverter();
});

describe("ImageProcessingService support surface", () => {
  it("accepts every sniffed type Notted.md lists, HEIC included", () => {
    const processor = service();
    for (const supported of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "image/heic",
    ] as const) {
      expect(processor.supports(supported)).toBe(true);
    }
  });

  it("reports HEIC as unsupported when no decoder loaded, so 415 happens before tx1", async () => {
    setHeicConverter(null);
    const processor = service();

    expect(processor.supports("image/heic")).toBe(false);
    // `AttachmentsService` checks `supports()` before creating a row; if it were
    // ever bypassed, `process()` must still refuse with the same code rather
    // than half-processing.
    await expect(
      processor.process({ buffer: garbageBytes(64), sniffed: "image/heic" }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.unsupportedMediaType });
  });

  it("publishes the operator-configured input ceiling for the multipart parser", () => {
    expect(service().maximumInputBytes).toBe(DEFAULTS.maximumImageUploadBytes);
    expect(service({ maximumImageUploadBytes: 1_000_000 }).maximumInputBytes).toBe(1_000_000);
  });
});

describe("ImageProcessingService variant matrix", () => {
  it("emits exactly original + full + medium + thumbnail for every raster format", async () => {
    const processor = service();

    for (const fixture of await allRasterFixtures()) {
      const result = await processor.process({
        buffer: fixture.bytes,
        sniffed: fixture.mimeType,
      });

      expect(result.objects.map((object) => object.variant)).toEqual([
        "original",
        "full",
        "medium",
        "thumbnail",
      ]);

      // `original` is the uploaded bytes, verbatim, under the sniffed type.
      const original = variant(result, "original");
      expect(original.body.equals(fixture.bytes)).toBe(true);
      expect(original.mimeType).toBe(fixture.mimeType);

      // Intrinsic dimensions are per-FRAME, never the animation filmstrip.
      expect(result.width).toBe(fixture.width);
      expect(result.height).toBe(fixture.height);

      for (const name of ["full", "medium", "thumbnail"] as const) {
        const object = variant(result, name);
        expect(object.body.byteLength).toBeGreaterThan(0);
        expect(["image/jpeg", "image/png", "image/gif", "image/webp"]).toContain(object.mimeType);
        expect(object.width).toBeGreaterThan(0);
        expect(object.height).toBeGreaterThan(0);
      }

      expect(variant(result, "medium").mimeType).toBe("image/webp");
      expect(variant(result, "thumbnail").mimeType).toBe("image/webp");
    }
  });

  it("keeps the source family for `full` so transparency and animation survive", async () => {
    const processor = service();

    // Opaque PNG has nothing to protect, so it becomes a much smaller JPEG...
    const opaque = await processor.process({
      buffer: (await pngFixture()).bytes,
      sniffed: "image/png",
    });
    expect(variant(opaque, "full").mimeType).toBe("image/jpeg");

    // ...but a PNG WITH an alpha channel must stay a PNG or it is destroyed.
    const alpha = await processor.process({
      buffer: (await alphaPngFixture()).bytes,
      sniffed: "image/png",
    });
    expect(variant(alpha, "full").mimeType).toBe("image/png");
    expect((await sharp(variant(alpha, "full").body).metadata()).hasAlpha).toBe(true);

    const webp = await processor.process({
      buffer: (await webpFixture()).bytes,
      sniffed: "image/webp",
    });
    expect(variant(webp, "full").mimeType).toBe("image/webp");

    const gif = await processor.process({
      buffer: (await staticGifFixture()).bytes,
      sniffed: "image/gif",
    });
    expect(variant(gif, "full").mimeType).toBe("image/gif");

    const jpeg = await processor.process({
      buffer: (await jpegFixture()).bytes,
      sniffed: "image/jpeg",
    });
    expect(variant(jpeg, "full").mimeType).toBe("image/jpeg");
  });

  it("bounds `full` to 2000 px and `medium`/`thumbnail` by width, preserving the ratio", async () => {
    const fixture = await jpegFixture(3_000, 1_000);
    const result = await service().process({ buffer: fixture.bytes, sniffed: "image/jpeg" });

    const full = variant(result, "full");
    expect(Math.max(full.width, full.height)).toBeLessThanOrEqual(FULL_LONGEST_EDGE_PX);
    expect(full.width).toBe(FULL_LONGEST_EDGE_PX);
    expect(full.height / full.width).toBeCloseTo(1 / 3, 2);

    const medium = variant(result, "medium");
    expect(medium.width).toBe(MEDIUM_WIDTH_PX);
    expect(medium.height / medium.width).toBeCloseTo(1 / 3, 2);

    const thumbnail = variant(result, "thumbnail");
    expect(thumbnail.width).toBe(THUMBNAIL_WIDTH_PX);
    expect(thumbnail.height / thumbnail.width).toBeCloseTo(1 / 3, 2);
  });

  it("never enlarges a small source: every rendition keeps its exact dimensions", async () => {
    const fixture = await alphaPngFixture(120, 80);
    const result = await service().process({ buffer: fixture.bytes, sniffed: "image/png" });

    for (const name of ["original", "full", "medium", "thumbnail"] as const) {
      expect(variant(result, name)).toMatchObject({ width: 120, height: 80 });
    }
    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
  });
});

describe("ImageProcessingService animation handling", () => {
  it("keeps every frame in `full` and renders a STATIC first frame for the small variants", async () => {
    const fixture = await animatedGifFixture(64, 3);
    const result = await service().process({ buffer: fixture.bytes, sniffed: "image/gif" });

    const full = variant(result, "full");
    expect(full.mimeType).toBe("image/gif");
    const fullMetadata = await sharp(full.body, { animated: true }).metadata();
    expect(fullMetadata.pages).toBe(3);
    // Per-frame geometry, not the filmstrip.
    expect(full.width).toBe(64);
    expect(full.height).toBe(64);

    // The deliberate trade-off: an animated 200 px rendition is routinely LARGER
    // than the still it sits beside, and nobody scrubs a thumbnail.
    for (const name of ["medium", "thumbnail"] as const) {
      const object = variant(result, name);
      expect(object.mimeType).toBe("image/webp");
      const metadata = await sharp(object.body).metadata();
      expect(metadata.pages ?? 1).toBe(1);
    }
  });

  it("treats an animated WebP exactly like an animated GIF", async () => {
    const fixture = await animatedWebpFixture(64, 3);
    const result = await service().process({ buffer: fixture.bytes, sniffed: "image/webp" });

    const full = variant(result, "full");
    expect(full.mimeType).toBe("image/webp");
    expect((await sharp(full.body, { animated: true }).metadata()).pages).toBe(3);
    expect((await sharp(variant(result, "thumbnail").body).metadata()).pages ?? 1).toBe(1);
  });

  it("refuses an animation with more frames than the configured budget", async () => {
    const fixture = await animatedGifFixture(32, 3);

    await expect(
      service({ maximumAnimationFrames: 2 }).process({
        buffer: fixture.bytes,
        sniffed: "image/gif",
      }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.tooManyFrames });
  });

  it("counts every frame against the pixel budget, not just one", async () => {
    const fixture = await animatedGifFixture(64, 3);

    // One 64x64 frame is 4096 px and fits comfortably; three do not.
    await expect(
      service({ maximumImagePixels: 8_000 }).process({
        buffer: fixture.bytes,
        sniffed: "image/gif",
      }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.tooManyPixels });
  });
});

describe("ImageProcessingService metadata stripping", () => {
  it("removes EXIF, GPS, and ICC from every derived rendition", async () => {
    const fixture = await jpegWithGpsFixture();
    // The fixture really does carry EXIF, or the assertion below proves nothing.
    expect((await sharp(fixture.bytes).metadata()).exif).toBeDefined();
    expect(fixture.bytes.includes(Buffer.from("Exif", "latin1"))).toBe(true);

    const result = await service().process({ buffer: fixture.bytes, sniffed: "image/jpeg" });

    for (const name of ["full", "medium", "thumbnail"] as const) {
      const object = variant(result, name);
      const metadata = await sharp(object.body).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(object.body.includes(Buffer.from("Exif", "latin1"))).toBe(false);
    }

    // `original` deliberately keeps the true uploaded bytes for retention and
    // reprocessing — and is not addressable through the `?variant=` enum.
    expect(variant(result, "original").body.equals(fixture.bytes)).toBe(true);
  });
});

describe("ImageProcessingService blur placeholder", () => {
  it("emits a bounded WebP data URI for every raster format", async () => {
    const processor = service();

    for (const fixture of await allRasterFixtures()) {
      const result = await processor.process({
        buffer: fixture.bytes,
        sniffed: fixture.mimeType,
      });

      expect(result.blur).not.toBeNull();
      const blur = result.blur as NonNullable<ProcessedImage["blur"]>;
      expect(blur.dataUri.startsWith("data:image/webp;base64,")).toBe(true);
      expect(Buffer.byteLength(blur.dataUri, "utf8")).toBeLessThanOrEqual(MAX_BLUR_DATA_URI_BYTES);
      expect(blur.width).toBeGreaterThan(0);
      expect(blur.height).toBeGreaterThan(0);
      expect(blur.width).toBeLessThanOrEqual(16);
    }
  });
});

describe("ImageProcessingService SVG handling", () => {
  it("rasterizes to PNG and WebP so no servable variant is ever image/svg+xml", async () => {
    const result = await service().process({
      buffer: Buffer.from(SAFE_SVG, "utf8"),
      sniffed: "image/svg+xml",
    });

    // The same four-object set as every raster format, so nothing downstream
    // needs an SVG special case.
    expect(result.objects.map((object) => object.variant)).toEqual([
      "original",
      "full",
      "medium",
      "thumbnail",
    ]);

    expect(variant(result, "full").mimeType).toBe("image/png");
    expect(variant(result, "medium").mimeType).toBe("image/webp");
    expect(variant(result, "thumbnail").mimeType).toBe("image/webp");
    for (const name of ["full", "medium", "thumbnail"] as const) {
      expect(variant(result, name).mimeType).not.toBe("image/svg+xml");
    }

    // The blur placeholder is a raster too — a `data:image/svg+xml` placeholder
    // would put attacker XML back into the metadata the editor inlines.
    expect(result.blur?.dataUri.startsWith("data:image/webp;base64,")).toBe(true);
    expect(Buffer.byteLength(result.blur?.dataUri ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_BLUR_DATA_URI_BYTES,
    );

    // Only `original` keeps the vector source, and it is unreachable through the
    // content endpoint's variant enum.
    expect(variant(result, "original").mimeType).toBe("image/svg+xml");

    // Rasterized at 96 dpi, so a declared 200x100 document renders larger than
    // its attribute values and keeps its 2:1 ratio.
    expect(result.width).toBeGreaterThan(200);
    expect((result.width ?? 0) / (result.height ?? 1)).toBeCloseTo(2, 1);
  });

  it.each(Object.entries(HOSTILE_SVGS))(
    "refuses the %s SVG with the unsafe_svg code and creates nothing",
    async (_name, source) => {
      await expect(
        service().process({ buffer: Buffer.from(source, "utf8"), sniffed: "image/svg+xml" }),
      ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.unsafeSvg });
    },
  );

  it("refuses an SVG source over the configured byte cap", async () => {
    await expect(
      service({ maximumSvgSourceBytes: 4_096 }).process({
        buffer: Buffer.from(`${SAFE_SVG}${"<!-- padding -->".repeat(1_000)}`, "utf8"),
        sniffed: "image/svg+xml",
      }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.unsafeSvg });
  });
});

describe("ImageProcessingService HEIC handling", () => {
  it("converts through the decoder seam and keeps image/heic as the original type", async () => {
    const jpeg = (await jpegFixture(200, 150)).bytes;
    const stub = vi.fn().mockResolvedValue(Uint8Array.from(jpeg));
    setHeicConverter(stub);

    const heic = Buffer.concat([Buffer.alloc(32, 0x00), Buffer.alloc(64, 0x11)]);
    const result = await service().process({ buffer: heic, sniffed: "image/heic" });

    expect(stub).toHaveBeenCalledTimes(1);
    // Same four-object set as every other format, and a bounded WebP placeholder.
    expect(result.objects.map((object) => object.variant)).toEqual([
      "original",
      "full",
      "medium",
      "thumbnail",
    ]);
    expect(result.blur?.dataUri.startsWith("data:image/webp;base64,")).toBe(true);
    expect(Buffer.byteLength(result.blur?.dataUri ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_BLUR_DATA_URI_BYTES,
    );
    // `Notted.md`'s "HEIC (convert to JPEG)": every derived rendition is raster.
    expect(variant(result, "full").mimeType).toBe("image/jpeg");
    expect(variant(result, "medium").mimeType).toBe("image/webp");
    expect(variant(result, "thumbnail").mimeType).toBe("image/webp");
    // The persisted type stays what was uploaded and sniffed.
    expect(variant(result, "original").mimeType).toBe("image/heic");
    expect(variant(result, "original").body.equals(heic)).toBe(true);
    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });

  it("applies the HEIC byte cap before entering the decoder", async () => {
    const stub = vi.fn().mockResolvedValue(Uint8Array.from([0xff]));
    setHeicConverter(stub);

    await expect(
      service({ maximumHeicUploadBytes: 1_024 }).process({
        buffer: garbageBytes(4_096),
        sniffed: "image/heic",
      }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.heicTooLarge });
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("ImageProcessingService hostile input", () => {
  it("rejects a decompression bomb from its HEADER, within the resource budget", async () => {
    // ~90 bytes of structurally valid PNG declaring 65535x65535 — about 12 GiB
    // decoded. It must never reach a decoder.
    const bomb = decompressionBombPng();
    expect(bomb.byteLength).toBeLessThan(200);

    const started = Date.now();
    await expect(service().process({ buffer: bomb, sniffed: "image/png" })).rejects.toMatchObject({
      code: ATTACHMENT_PROCESSING_ERRORS.tooManyPixels,
    });
    expect(Date.now() - started).toBeLessThan(REJECTION_BUDGET_MS);
  });

  it("rejects a truncated JPEG instead of emitting a half-decoded image", async () => {
    const started = Date.now();
    await expect(
      service().process({ buffer: await truncatedJpeg(), sniffed: "image/jpeg" }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.decodeFailed });
    expect(Date.now() - started).toBeLessThan(REJECTION_BUDGET_MS);
  });

  it("rejects bytes that are not an image at all", async () => {
    await expect(
      service().process({ buffer: garbageBytes(), sniffed: "image/png" }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.decodeFailed });
  });

  it("keeps every persisted failure code short, stable, and content-free", async () => {
    // `.catch()` alone widens the awaited type to
    // `ProcessedImage | { code: string }`, and `.code` exists on neither side
    // of that union. Handling both settlements with an explicit type argument
    // collapses it to the rejection shape AND turns an unexpected *resolution*
    // into a clear failure instead of a confusing `undefined` regex mismatch.
    const failure = await service()
      .process({ buffer: garbageBytes(), sniffed: "image/png" })
      .then<{ code: string }, { code: string }>(
        () => {
          throw new Error("expected process() to reject for non-image bytes");
        },
        (error: unknown) => error as { code: string },
      );

    expect(failure.code).toMatch(/^[a-z_]{1,40}$/u);
    expect(Object.values(ATTACHMENT_PROCESSING_ERRORS)).toContain(failure.code);
  });
});
