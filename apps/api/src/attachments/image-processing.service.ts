// Part 41: the Sharp-backed image processor that fills Part 40's seam.
//
// Contract: turn one uploaded buffer into `original` + `full` + `medium` +
// `thumbnail` objects, an optional inline `blur` placeholder, and intrinsic
// dimensions. Nothing here touches the database, authorization, object keys, or
// the object store — `AttachmentsService` owns all of that and needed no change
// beyond reading the operator-configured input ceiling off this interface.
//
// ORDER IS A SECURITY PROPERTY:
//   1. format-specific gate (SVG prescan / HEIC byte cap + decode)
//   2. `.metadata()` — header only, NO pixel work
//   3. explicit pixel and frame budget check   <-- the decompression-bomb gate
//   4. only now is a decoder allowed to touch pixels
// A 200 KB PNG whose IHDR declares 65535x65535 dies at step 3 (measured: ~1 ms).
//
// METADATA STRIPPING IS BY OMISSION. `keepMetadata`/`keepExif`/`keepIccProfile`
// are never called, so Sharp's default applies and EXIF, GPS, XMP, IPTC, and ICC
// are dropped from every derived rendition. `.rotate()` with no argument is
// called BEFORE `.resize()` on still images so EXIF orientation is baked into
// the pixels before the tag that described it is discarded — otherwise stripping
// metadata would silently rotate everyone's phone photos.
//
// PROCESSING IS SYNCHRONOUS INSIDE THE REQUEST (Part 40's decision; a BullMQ
// pipeline is Part 50). That is why every step has a byte cap, a pixel cap, a
// frame cap, and a wall-clock cap.

import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";

import {
  IMAGE_PROCESSING_CONFIG,
  type ImageProcessingConfig,
} from "../config/image-processing.config";

import { ATTACHMENT_PROCESSING_ERRORS } from "./attachments.constants";
import { decodeHeicToJpeg, isHeicDecoderAvailable } from "./heic-decoder";
import {
  ImageProcessingError,
  type ImageProcessingRequest,
  type ImageProcessor,
  type ProcessedImage,
  type ProcessedImageBlur,
  type ProcessedImageObject,
} from "./image-processing";
import {
  animatedTargetWidth,
  blurDataUri,
  blurDataUriWithinBudget,
  BLUR_WEBP_QUALITY,
  BLUR_WIDTH_PX,
  boundLongestEdge,
  FULL_JPEG_QUALITY,
  FULL_LONGEST_EDGE_PX,
  FULL_WEBP_QUALITY,
  MEDIUM_WEBP_QUALITY,
  MEDIUM_WIDTH_PX,
  needsResize,
  THUMBNAIL_WEBP_QUALITY,
  THUMBNAIL_WIDTH_PX,
} from "./image-variants";
import { scanSvgSource } from "./svg-safety";

import type { SniffedImageType } from "./image-signature";
import type { Metadata, Sharp } from "sharp";

/** Encoded output family of a derived rendition. */
type OutputFormat = "jpeg" | "png" | "webp" | "gif";

const OUTPUT_MIME_TYPES: Readonly<Record<OutputFormat, string>> = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
});

/**
 * Formats this processor accepts. SVG and HEIC are included — unlike Part 40's
 * passthrough — because both now become raster variants. HEIC additionally
 * requires the JS decoder to be loadable; see `supports()`.
 */
const SUPPORTED_TYPES: ReadonlySet<SniffedImageType> = new Set<SniffedImageType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
]);

/** Formats whose container can carry more than one frame. */
const ANIMATION_CAPABLE: ReadonlySet<SniffedImageType> = new Set<SniffedImageType>([
  "image/gif",
  "image/webp",
]);

/**
 * SVG rasterization density. librsvg scales by `density / 72`, so 96 dpi renders
 * a declared 100x50 document at 133x67 — measured, and the reason the pixel
 * budget is checked against the RASTERIZED metadata rather than the declared
 * `width`/`height` attributes.
 */
const SVG_RASTER_DENSITY = 96;

/** libvips phrasings that mean "declared dimensions exceed the budget". */
const PIXEL_LIMIT_MARKER = /pixel limit/iu;

interface DecodedSource {
  /** Bytes handed to Sharp; differs from the upload only for HEIC. */
  readonly buffer: Buffer;
  /** Whether Sharp must open the input as a filmstrip. */
  readonly animationCapable: boolean;
  /** Extra Sharp input options (SVG density). */
  readonly density?: number;
}

interface SourceShape {
  /** Intrinsic dimensions of ONE frame. */
  readonly frame: { readonly width: number; readonly height: number };
  readonly pages: number;
  readonly animated: boolean;
  readonly hasAlpha: boolean;
}

@Injectable()
export class ImageProcessingService implements ImageProcessor {
  constructor(@Inject(IMAGE_PROCESSING_CONFIG) private readonly config: ImageProcessingConfig) {}

  /**
   * Operator-configured per-image byte ceiling. `AttachmentsService` reads this
   * through the {@link ImageProcessor} interface and hands it to the multipart
   * parser, so an oversize upload is refused with a clean 413 before a byte is
   * buffered rather than becoming a `failed` row after the fact.
   */
  get maximumInputBytes(): number {
    return this.config.maximumImageUploadBytes;
  }

  /**
   * Checked BEFORE any database row exists. HEIC is reported as supported only
   * when the decoder actually loaded: a build without it returns 415 up front
   * instead of accepting the upload and failing during processing.
   */
  supports(sniffed: SniffedImageType): boolean {
    if (sniffed === "image/heic") return isHeicDecoderAvailable();
    return SUPPORTED_TYPES.has(sniffed);
  }

  async process(request: ImageProcessingRequest): Promise<ProcessedImage> {
    if (!this.supports(request.sniffed)) {
      throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.unsupportedMediaType);
    }
    return this.withBudget(this.run(request));
  }

  // ------------------------------------------------------------------ //
  // Pipeline
  // ------------------------------------------------------------------ //

  private async run(request: ImageProcessingRequest): Promise<ProcessedImage> {
    const source = await this.prepare(request);
    const shape = await this.measure(source);

    const objects: ProcessedImageObject[] = [
      // `original` is the UPLOADED bytes, verbatim, under the sniffed type. It
      // is retained for retention and reprocessing and is deliberately not
      // addressable through the `?variant=` enum, which is what lets `full` be a
      // bounded re-encode without losing the true source.
      Object.freeze({
        variant: "original" as const,
        body: request.buffer,
        mimeType: request.sniffed,
        width: shape.frame.width,
        height: shape.frame.height,
      }),
      await this.buildFull(request.sniffed, source, shape),
      await this.buildStatic(
        "medium",
        source,
        shape,
        MEDIUM_WIDTH_PX,
        MEDIUM_WEBP_QUALITY,
        ATTACHMENT_PROCESSING_ERRORS.variantFailed,
      ),
      await this.buildStatic(
        "thumbnail",
        source,
        shape,
        THUMBNAIL_WIDTH_PX,
        THUMBNAIL_WEBP_QUALITY,
        ATTACHMENT_PROCESSING_ERRORS.variantFailed,
      ),
    ];

    return Object.freeze({
      width: shape.frame.width,
      height: shape.frame.height,
      objects: Object.freeze(objects),
      blur: await this.buildBlur(source),
    });
  }

  /** Format-specific admission. The only step that can change the bytes. */
  private async prepare(request: ImageProcessingRequest): Promise<DecodedSource> {
    if (request.sniffed === "image/svg+xml") {
      const scan = scanSvgSource(request.buffer, this.config.maximumSvgSourceBytes);
      if (!scan.safe) {
        // The specific reason stays in-process; only the short stable code is
        // ever persisted or returned.
        throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.unsafeSvg);
      }
      return Object.freeze({
        buffer: request.buffer,
        animationCapable: false,
        density: SVG_RASTER_DENSITY,
      });
    }

    if (request.sniffed === "image/heic") {
      const jpeg = await decodeHeicToJpeg(request.buffer, {
        maximumBytes: Math.min(
          this.config.maximumHeicUploadBytes,
          this.config.maximumImageUploadBytes,
        ),
        timeoutMs: this.config.heicDecodeTimeoutMs,
      });
      return Object.freeze({ buffer: jpeg, animationCapable: false });
    }

    return Object.freeze({
      buffer: request.buffer,
      animationCapable: ANIMATION_CAPABLE.has(request.sniffed),
    });
  }

  /**
   * THE DECOMPRESSION-BOMB GATE. `.metadata()` parses the header only — it never
   * decodes pixels — so the declared geometry can be judged before a decoder is
   * ever entered.
   */
  private async measure(source: DecodedSource): Promise<SourceShape> {
    let metadata: Metadata;
    try {
      metadata = await this.open(source, source.animationCapable).metadata();
    } catch (error: unknown) {
      throw this.metadataFailure(error);
    }

    const width = metadata.width ?? 0;
    const pages = metadata.pages ?? 1;
    // When Sharp opens an animated image it reports `height` as the whole
    // filmstrip (`pageHeight * pages`) and `pageHeight` as one frame. A static
    // image has no `pageHeight` at all.
    const frameHeight = metadata.pageHeight ?? metadata.height ?? 0;

    if (
      width <= 0 ||
      frameHeight <= 0 ||
      !Number.isFinite(width) ||
      !Number.isFinite(frameHeight)
    ) {
      throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.decodeFailed);
    }
    if (pages > this.config.maximumAnimationFrames) {
      throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.tooManyFrames);
    }
    // One frame must fit, AND the whole animation must fit: a 2000x2000 image is
    // fine, four hundred of them are not.
    if (
      width * frameHeight > this.config.maximumImagePixels ||
      width * frameHeight * pages > this.config.maximumImagePixels
    ) {
      throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.tooManyPixels);
    }

    return Object.freeze({
      frame: Object.freeze({ width, height: frameHeight }),
      pages,
      animated: source.animationCapable && pages > 1,
      hasAlpha: metadata.hasAlpha === true,
    });
  }

  /**
   * `full`: a metadata-stripped re-encode bounded to a 2000 px longest edge.
   *
   * Format follows the SOURCE FAMILY so nothing that mattered is silently lost:
   * an animated GIF stays an animated GIF, an animated WebP stays animated WebP,
   * a PNG with transparency stays PNG, a rasterized SVG becomes PNG (it may have
   * alpha). Everything else becomes JPEG.
   */
  private async buildFull(
    sniffed: SniffedImageType,
    source: DecodedSource,
    shape: SourceShape,
  ): Promise<ProcessedImageObject> {
    const format = this.fullFormat(sniffed, shape);

    let pipeline: Sharp;
    if (shape.animated) {
      // ANIMATION IS PRESERVED HERE AND ONLY HERE (deliberate; recorded).
      // An animated source is opened as a filmstrip and re-encoded frame for
      // frame, loop count included. Only a WIDTH is ever passed: alongside
      // `animated: true` a height bounds the strip rather than the frame and
      // would truncate the animation.
      pipeline = this.open(source, true);
      const targetWidth = animatedTargetWidth(shape.frame, FULL_LONGEST_EDGE_PX);
      if (targetWidth !== shape.frame.width) {
        pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
      }
    } else {
      const target = boundLongestEdge(shape.frame, FULL_LONGEST_EDGE_PX);
      // EXIF orientation must be applied to the pixels BEFORE the resize, and
      // before the metadata that described it is dropped.
      pipeline = this.open(source, false).rotate();
      if (needsResize(shape.frame, target)) {
        pipeline = pipeline.resize({
          width: FULL_LONGEST_EDGE_PX,
          height: FULL_LONGEST_EDGE_PX,
          fit: "inside",
          withoutEnlargement: true,
        });
      }
    }

    // The `full` encode is the first pixel work of the pipeline, so a source
    // that is truncated or corrupt beyond its header dies here and is reported
    // as a DECODE failure. Later renditions failing means the decode worked and
    // one variant did not, which is a different operational signal.
    return this.encode(
      "full",
      pipeline,
      format,
      ATTACHMENT_PROCESSING_ERRORS.decodeFailed,
      shape.frame,
    );
  }

  /**
   * `medium` / `thumbnail`: always a STATIC, first-frame WebP.
   *
   * DELIBERATE TRADE-OFF (Plan.md asks for animated GIF behaviour to be
   * deliberate): resizing an animation down to 200 px does not make it small —
   * every frame is still encoded, and an animated 200 px WebP routinely exceeds
   * the still `medium` it sits next to. Nobody scrubs a thumbnail. `full` keeps
   * the motion; the small renditions are posters.
   */
  private async buildStatic(
    variant: "medium" | "thumbnail",
    source: DecodedSource,
    shape: SourceShape,
    width: number,
    quality: number,
    failureCode: (typeof ATTACHMENT_PROCESSING_ERRORS)[keyof typeof ATTACHMENT_PROCESSING_ERRORS],
  ): Promise<ProcessedImageObject> {
    const pipeline = this.open(source, false)
      .rotate()
      .resize({ width, fit: "inside", withoutEnlargement: true });
    return this.encode(variant, pipeline, "webp", failureCode, shape.frame, quality);
  }

  /**
   * A 16 px WebP carried inline as a `data:` URI in the jsonb variant record —
   * not a stored object, not a blurhash.
   *
   * It costs zero extra HTTP round trips and zero extra authorization checks,
   * because it rides along with the metadata the editor already fetches on note
   * load. It is bounded, and if the bound is ever exceeded the placeholder is
   * DROPPED and the upload still succeeds: a decorative blur must never fail an
   * upload.
   *
   * The data URI never enters the note document. `sanitizeDocumentUrl` in
   * `packages/shared-validators/src/document.schema.ts` rejects `data:`, and the
   * Part 42 image node has no attribute that could hold one — that is how
   * Plan.md's "the saved document never relies on temporary blob/base64 URLs" is
   * satisfied structurally rather than by convention.
   */
  private async buildBlur(source: DecodedSource): Promise<ProcessedImageBlur | null> {
    try {
      const encoded = await this.open(source, false)
        .rotate()
        .resize({ width: BLUR_WIDTH_PX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: BLUR_WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });
      const dataUri = blurDataUri(encoded.data, OUTPUT_MIME_TYPES.webp);
      if (!blurDataUriWithinBudget(dataUri)) return null;
      return Object.freeze({
        dataUri,
        width: encoded.info.width,
        height: encoded.info.height,
      });
    } catch {
      // Everything servable already succeeded by the time this runs.
      return null;
    }
  }

  // ------------------------------------------------------------------ //
  // Sharp plumbing
  // ------------------------------------------------------------------ //

  /**
   * One place that constructs a Sharp instance, so every decode carries the same
   * limits. A fresh instance per rendition keeps each output independent;
   * libvips caches the decoded input across them.
   */
  private open(source: DecodedSource, animated: boolean): Sharp {
    return sharp(source.buffer, {
      // libvips' own backstop behind this service's explicit budget check.
      limitInputPixels: this.config.maximumImagePixels,
      sequentialRead: true,
      // Sharp's strictest setting: refuse truncated or structurally damaged
      // input instead of silently emitting a half-grey image.
      failOn: "warning",
      // Keep libvips' internal memory cap.
      unlimited: false,
      animated,
      ...(source.density === undefined ? {} : { density: source.density }),
    });
  }

  private fullFormat(sniffed: SniffedImageType, shape: SourceShape): OutputFormat {
    if (sniffed === "image/svg+xml") return "png";
    if (sniffed === "image/gif") return "gif";
    if (sniffed === "image/webp") return "webp";
    // Transparency cannot survive a JPEG, so an alpha PNG stays a PNG.
    if (sniffed === "image/png" && shape.hasAlpha) return "png";
    return "jpeg";
  }

  private async encode(
    variant: ProcessedImageObject["variant"],
    pipeline: Sharp,
    format: OutputFormat,
    failureCode: (typeof ATTACHMENT_PROCESSING_ERRORS)[keyof typeof ATTACHMENT_PROCESSING_ERRORS],
    fallback: { readonly width: number; readonly height: number },
    quality?: number,
  ): Promise<ProcessedImageObject> {
    try {
      const encoded = await this.applyEncoder(pipeline, format, quality).toBuffer({
        resolveWithObject: true,
      });
      // Sharp's reported output geometry is the record of truth: libvips does not
      // use one uniform rounding rule (a JPEG source may shrink-on-load first),
      // so a locally computed number could disagree with the stored bytes.
      // For an animated output `info.height` is the whole filmstrip, so the
      // per-frame height is recovered from `pageHeight`.
      const pages = encoded.info.pages ?? 1;
      const height =
        encoded.info.pageHeight ??
        (pages > 1 ? Math.round(encoded.info.height / pages) : encoded.info.height);
      return Object.freeze({
        variant,
        body: encoded.data,
        mimeType: OUTPUT_MIME_TYPES[format],
        width: encoded.info.width > 0 ? encoded.info.width : fallback.width,
        height: height > 0 ? height : fallback.height,
      });
    } catch (error: unknown) {
      if (error instanceof ImageProcessingError) throw error;
      throw new ImageProcessingError(failureCode);
    }
  }

  private applyEncoder(pipeline: Sharp, format: OutputFormat, quality?: number): Sharp {
    switch (format) {
      case "jpeg":
        return pipeline.jpeg({ quality: quality ?? FULL_JPEG_QUALITY });
      case "png":
        // `palette: false` keeps a photographic rasterization from being
        // quantized to 256 colours.
        return pipeline.png({ compressionLevel: 9, palette: false });
      case "gif":
        // `reuse: false` rebuilds the global palette after a resize; the default
        // (`reuse: true`) keeps the source palette, which is the wrong one once
        // the frames have been resampled.
        return pipeline.gif({ reuse: false });
      case "webp":
        return pipeline.webp({ quality: quality ?? FULL_WEBP_QUALITY });
    }
  }

  private metadataFailure(error: unknown): ImageProcessingError {
    if (error instanceof ImageProcessingError) return error;
    const message = error instanceof Error ? error.message : "";
    // libvips refuses an over-large declaration itself; surface the accurate
    // budget code when it does, and degrade to `decode_failed` if the phrasing
    // ever changes. The explicit check in `measure()` is the primary gate either
    // way.
    return new ImageProcessingError(
      PIXEL_LIMIT_MARKER.test(message)
        ? ATTACHMENT_PROCESSING_ERRORS.tooManyPixels
        : ATTACHMENT_PROCESSING_ERRORS.decodeFailed,
    );
  }

  /**
   * Wall-clock bound for the whole pipeline. libvips work cannot be cancelled,
   * so this bounds the REQUEST, not the CPU: the orphaned encode finishes in the
   * background and its result is discarded. That is acceptable only because the
   * byte, pixel, and frame caps already bound how much work can be started.
   * Part 50's worker gets a killable process.
   */
  private async withBudget<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.processingTimeout));
      }, this.config.processingTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
