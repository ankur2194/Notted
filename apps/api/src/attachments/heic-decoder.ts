// Part 41: the ONE import site for a HEIC decoder.
//
// WHY A SEPARATE DECODER EXISTS AT ALL (verified, not assumed):
// the installed `sharp@0.35.0` bundles libvips 8.18.3, whose prebuilt binary
// reports `sharp.format.heif.input.fileSuffix === [".avif"]`. Sharp's own typings
// say HEIC needs "a globally-installed libvips compiled with support for
// libheif, libde265 and x265". The container ships the prebuilt binary, so
// **Sharp cannot decode HEIC here**. `Notted.md` requires "HEIC (convert to
// JPEG)", so the conversion is done in JavaScript first and the resulting JPEG
// then travels the ordinary Sharp pipeline.
//
// EVERY heic-convert reference in the codebase is in this file. Dropping HEIC
// support (see the licence note below) is therefore a one-file change:
// `setHeicConverter(null)` semantics already exist, `supports()` already
// consults `isHeicDecoderAvailable()`, and an unsupported HEIC upload already
// returns 415 BEFORE any database row is created.
//
// LICENCE FLAG FOR REVIEW: `heic-convert@2.1.0` (ISC) → `heic-decode@2.1.0`
// (ISC) → **`libheif-js@1.19.8` (LGPL-3.0)**. The API is server-side and is not
// distributed to users, and the dependency is a separately replaceable
// `node_modules` package rather than a static link, so the LGPL's relinking
// obligation is satisfied structurally. This is still the one item in Part 41
// that needs an explicit human sign-off; it is called out in the completion
// record.
//
// GUARDING IS MANDATORY, NOT OPTIONAL. Processing runs synchronously inside the
// upload request, and a pure-JS/WASM decoder cannot be interrupted once it
// enters a tight loop. Two independent bounds apply:
//   * `maximumBytes` — refuses before the decoder is entered at all.
//   * `timeoutMs` — a `Promise.race` that gives the REQUEST a bound. The decode
//     itself keeps running to completion in the background; the timeout bounds
//     the caller, not the CPU. Moving this to a worker with a killable process
//     is Part 50.

import convert from "heic-convert";

import { ATTACHMENT_PROCESSING_ERRORS } from "./attachments.constants";
import { ImageProcessingError } from "./image-processing";

export interface HeicDecodeOptions {
  readonly maximumBytes: number;
  readonly timeoutMs: number;
}

/** The narrow slice of `heic-convert` this module uses. */
export type HeicConverter = (input: {
  buffer: Uint8Array;
  format: "JPEG";
  quality?: number;
}) => Promise<Uint8Array>;

/** Quality of the intermediate JPEG. High, because every variant re-encodes it. */
const INTERMEDIATE_JPEG_QUALITY = 0.92;

let converter: HeicConverter | null = convert;

/**
 * Test seam. Pass `null` to simulate a build with no HEIC decoder and prove that
 * `supports()` refuses HEIC up front (415, no `failed` row) rather than
 * accepting the upload and failing during processing.
 */
export function setHeicConverter(next: HeicConverter | null): void {
  converter = next;
}

/** Restore the real decoder. Always call this in a test `afterEach`. */
export function resetHeicConverter(): void {
  converter = convert;
}

export function isHeicDecoderAvailable(): boolean {
  return converter !== null;
}

/**
 * Decode HEIC/HEIF to JPEG bytes, or throw an {@link ImageProcessingError} with
 * a short stable code. The decoder's own error messages are discarded: they can
 * quote file structure and must never reach `processing_error` or a log line.
 */
export async function decodeHeicToJpeg(
  source: Buffer,
  options: HeicDecodeOptions,
): Promise<Buffer> {
  const active = converter;
  if (active === null) {
    throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.unsupportedMediaType);
  }
  if (source.byteLength > options.maximumBytes) {
    throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.heicTooLarge);
  }

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.heicDecodeTimeout));
    }, options.timeoutMs);
    // Never hold the event loop open on this timer.
    timer.unref?.();
  });

  try {
    const decoded = await Promise.race([
      // `Uint8Array.from` copies; a Buffer view is a Uint8Array but the decoder
      // is handed a plain copy so it cannot retain a slice of a pooled buffer.
      active({
        buffer: Uint8Array.from(source),
        format: "JPEG",
        quality: INTERMEDIATE_JPEG_QUALITY,
      }),
      expiry,
    ]);
    return Buffer.from(decoded);
  } catch (error: unknown) {
    if (error instanceof ImageProcessingError) throw error;
    throw new ImageProcessingError(ATTACHMENT_PROCESSING_ERRORS.decodeFailed);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
