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
// LICENCE — SIGNED OFF 2026-08-07, DECISION: KEEP. The chain is
// `heic-convert@2.1.0` (ISC) → `heic-decode@2.1.0` (ISC) →
// **`libheif-js@1.19.8` (LGPL-3.0)**. The project owner reviewed this and chose
// to keep the dependency, discharging the LGPL obligations through attribution.
// Rationale in short: LGPL-3.0 triggers on conveying, not on use (it is not
// AGPL, so serving requests is not distribution); where Notted does convey, the
// §4 relinking requirement is met structurally because `libheif-js` is
// `require()`d as a separate, unmodified `node_modules` package into which no
// Notted code is ever combined; and nothing propagates into `apps/api`, whose
// only interface here is `heic-convert`'s ISC API.
//
// THE AUTHORITATIVE RECORD IS `THIRD-PARTY-NOTICES.md` AT THE REPOSITORY ROOT;
// ADR 0008 carries the matrix row. Read them before changing anything about how
// this dependency is packaged. Three standing obligations follow from the
// sign-off: never modify the package (no patch, no `pnpm.patchedDependencies`,
// no vendoring), ship the notice and source offer with anything distributed,
// and keep the package separately replaceable. ⚠️ That last one is the live
// risk: adopting a bundler for `apps/api` (esbuild, `ncc`, webpack, or any
// single-file/standalone-binary output) would fuse this package into one
// artifact and invalidate the relinking analysis — re-analyse before shipping.
// This is a documented engineering position recorded for traceability, not
// legal advice.
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
