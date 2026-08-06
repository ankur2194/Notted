// Part 41: resource budgets for synchronous image ingestion.
//
// Every value has a safe default, so `env:validate --production` passes with
// none of these set and an operator only ever *lowers* a ceiling. The budgets
// exist because Part 41 decodes the whole payload IN-PROCESS inside the upload
// request (a BullMQ pipeline is Part 50): an unbounded decode is a denial of
// service against the API itself, not just against one request.
//
// Registered in BOTH `config.module.ts` and `validate-api-environment.ts`,
// following `security.config.ts`. (`retention.config.ts` is registered in only
// one of the two — deliberately not copied.)

import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readInteger, wrapConfigError } from "./environment-readers";

export const IMAGE_PROCESSING_CONFIG = Symbol("IMAGE_PROCESSING_CONFIG");

export interface ImageProcessingConfig {
  /** Per-image byte ceiling handed to the multipart parser. */
  readonly maximumImageUploadBytes: number;
  /** Decoded pixel budget: `width * height * pages` for one image. */
  readonly maximumImagePixels: number;
  /** Frame ceiling for animated GIF/WebP. */
  readonly maximumAnimationFrames: number;
  /** Wall-clock budget for the whole variant pipeline of one upload. */
  readonly processingTimeoutMs: number;
  /** Byte ceiling for an SVG source before the safety prescan runs. */
  readonly maximumSvgSourceBytes: number;
  /** Byte ceiling for a HEIC source; far below the image ceiling because the
   * decoder is pure JS/WASM and cannot be interrupted mid-frame. */
  readonly maximumHeicUploadBytes: number;
  /** Wall-clock budget for the HEIC decode step alone. */
  readonly heicDecodeTimeoutMs: number;
}

/** Mirrors `security.config.ts` so the generic ceiling can only lower this one. */
const UPLOAD_CEILING_DEFAULT = 50 * 1_024 * 1_024;
const UPLOAD_CEILING_MINIMUM = 1_024;
const UPLOAD_CEILING_MAXIMUM = 2 * 1_024 * 1_024 * 1_024;

const IMAGE_UPLOAD_DEFAULT = 15 * 1_024 * 1_024;
const IMAGE_UPLOAD_MINIMUM = 64 * 1_024;

export function parseImageProcessingConfig(environment: Environment): ImageProcessingConfig {
  try {
    // `MAX_UPLOAD_SIZE_BYTES` is the generic transport ceiling. Read it with the
    // same bounds `security.config.ts` uses so the image ceiling can never be
    // configured above it.
    const uploadCeiling = readInteger(
      environment,
      "MAX_UPLOAD_SIZE_BYTES",
      UPLOAD_CEILING_DEFAULT,
      UPLOAD_CEILING_MINIMUM,
      UPLOAD_CEILING_MAXIMUM,
    );

    return Object.freeze({
      maximumImageUploadBytes: readInteger(
        environment,
        "MAX_IMAGE_UPLOAD_BYTES",
        Math.min(IMAGE_UPLOAD_DEFAULT, uploadCeiling),
        // Clamp the floor too: an operator who lowered the generic ceiling below
        // 64 KiB must not be told the range is empty.
        Math.min(IMAGE_UPLOAD_MINIMUM, uploadCeiling),
        uploadCeiling,
      ),
      maximumImagePixels: readInteger(
        environment,
        "MAX_IMAGE_PIXELS",
        50_000_000,
        1_000_000,
        250_000_000,
      ),
      maximumAnimationFrames: readInteger(
        environment,
        "MAX_IMAGE_ANIMATION_FRAMES",
        400,
        1,
        10_000,
      ),
      processingTimeoutMs: readInteger(
        environment,
        "IMAGE_PROCESSING_TIMEOUT_MS",
        20_000,
        1_000,
        120_000,
      ),
      maximumSvgSourceBytes: readInteger(
        environment,
        "MAX_SVG_SOURCE_BYTES",
        2 * 1_024 * 1_024,
        4 * 1_024,
        16 * 1_024 * 1_024,
      ),
      maximumHeicUploadBytes: readInteger(
        environment,
        "MAX_HEIC_UPLOAD_BYTES",
        8 * 1_024 * 1_024,
        64 * 1_024,
        64 * 1_024 * 1_024,
      ),
      heicDecodeTimeoutMs: readInteger(
        environment,
        "HEIC_DECODE_TIMEOUT_MS",
        10_000,
        1_000,
        60_000,
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid image processing configuration", error);
  }
}

@Injectable()
export class ImageProcessingConfigProvider {
  readonly value = parseImageProcessingConfig(process.env);
}

export const imageProcessingConfigProvider: Provider<ImageProcessingConfig> = {
  provide: IMAGE_PROCESSING_CONFIG,
  inject: [ImageProcessingConfigProvider],
  useFactory: (provider: ImageProcessingConfigProvider): ImageProcessingConfig => provider.value,
};
