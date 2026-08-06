// Part 40: the image-processing SEAM. Part 41 filled it.
//
// The production implementation is `ImageProcessingService` in
// `image-processing.service.ts` (Sharp-backed: rasterizes SVG, converts HEIC,
// strips EXIF/GPS/XMP/ICC, emits thumbnail/medium/full plus a blur placeholder).
// It is bound to the {@link IMAGE_PROCESSOR} token in `attachments.module.ts`.
// `AttachmentsService` depends only on the {@link ImageProcessor} interface.
//
// {@link PassthroughImageProcessor} REMAINS, deliberately: it is the inert
// implementation the service and tenant-isolation unit suites inject so they can
// exercise the upload lifecycle without pulling a native decoder into a test
// that is about authorization and transactions. It is no longer `@Injectable()`
// and is no longer a Nest provider — it has no dependencies and is constructed
// directly by tests.
//
// Processing runs SYNCHRONOUSLY inside the upload request. A BullMQ pipeline is
// Part 50's scope; the `processing_status` transitions and the compensating
// cleanup are already recorded so moving the work to a worker later is a
// transport change, not a redesign.

import { MAX_IMAGE_UPLOAD_BYTES } from "@notted/shared-validators";

import { ATTACHMENT_PROCESSING_ERRORS } from "./attachments.constants";

import type { AttachmentObjectVariant } from "./attachment-storage-key";
import type { AttachmentProcessingErrorCode } from "./attachments.constants";
import type { SniffedImageType } from "./image-signature";

export const IMAGE_PROCESSOR = Symbol("IMAGE_PROCESSOR");

export interface ImageProcessingRequest {
  readonly buffer: Buffer;
  readonly sniffed: SniffedImageType;
}

export interface ProcessedImageObject {
  readonly variant: AttachmentObjectVariant;
  readonly body: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

export interface ProcessedImageBlur {
  readonly dataUri: string;
  readonly width: number;
  readonly height: number;
}

export interface ProcessedImage {
  readonly width: number | null;
  readonly height: number | null;
  readonly objects: readonly ProcessedImageObject[];
  readonly blur: ProcessedImageBlur | null;
}

/** Failure carrying a short, stable code that is safe to persist and return. */
export class ImageProcessingError extends Error {
  constructor(readonly code: AttachmentProcessingErrorCode) {
    super(`image processing failed: ${code}`);
    this.name = "ImageProcessingError";
  }
}

export interface ImageProcessor {
  /**
   * Largest input this processor will accept, in bytes.
   *
   * WIDENED BY PART 41 (deliberate, recorded). `AttachmentsService` hands this
   * to the multipart parser, which is the only place an oversize upload can be
   * refused with a clean 413 *before* bytes are buffered. Exposing it on the
   * interface — rather than injecting the image config into the service — keeps
   * `AttachmentsService`'s constructor unchanged and keeps the ceiling owned by
   * whoever actually does the decoding.
   */
  readonly maximumInputBytes: number;
  /**
   * Whether this processor can turn `sniffed` into at least one browser-servable
   * raster variant. Checked BEFORE any database row is created so an
   * unsupported format never leaves a `failed` row behind.
   */
  supports(sniffed: SniffedImageType): boolean;
  process(request: ImageProcessingRequest): Promise<ProcessedImage>;
}

/**
 * Inert seam implementation: stores the sniffed bytes verbatim as the `original`
 * variant and derives nothing. It supports only formats a browser can already
 * decode, so `original` is always safely servable inline.
 *
 * NOT the production processor — `ImageProcessingService` is. This one exists so
 * unit suites about authorization, tenancy, quota, and transaction ordering can
 * run without a native image decoder. Its `maximumInputBytes` is the shared
 * contract's static ceiling; the real processor's is operator-configurable.
 */
export class PassthroughImageProcessor implements ImageProcessor {
  private static readonly SUPPORTED = new Set<SniffedImageType>([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);

  readonly maximumInputBytes = MAX_IMAGE_UPLOAD_BYTES;

  supports(sniffed: SniffedImageType): boolean {
    return PassthroughImageProcessor.SUPPORTED.has(sniffed);
  }

  process(request: ImageProcessingRequest): Promise<ProcessedImage> {
    if (!this.supports(request.sniffed)) {
      return Promise.reject(
        new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.unsupportedMediaType),
      );
    }
    return Promise.resolve(
      Object.freeze({
        // Dimensions require a decoder; Part 41 fills them in. `null` is the
        // schema's documented "not yet extracted" value.
        width: null,
        height: null,
        objects: Object.freeze([
          Object.freeze({
            variant: "original" as const,
            body: request.buffer,
            mimeType: request.sniffed,
            width: 0,
            height: 0,
          }),
        ]),
        blur: null,
      }),
    );
  }
}
