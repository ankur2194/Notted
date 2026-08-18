import { isAbsolute } from "node:path/posix";

import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readInteger,
  readOptionalString,
  wrapConfigError,
} from "./environment-readers";

export const EXPORT_CONFIG = Symbol("EXPORT_CONFIG");

export interface ExportConfig {
  /** Absolute path to the Chromium binary, or `null` when PDF export is disabled. */
  readonly chromiumPath: string | null;
  /** Wall-clock ceiling for one page render (setContent + pdf). */
  readonly renderTimeoutMs: number;
  /** Hard cap on a generated artefact, in bytes. */
  readonly maxArtifactBytes: number;
}

const NUL_CHARACTER = String.fromCharCode(0);

function readChromiumPath(environment: Environment): string | null {
  const value = readOptionalString(environment, "EXPORT_CHROMIUM_PATH");
  if (value === undefined) {
    return null;
  }

  // The binary-exists check belongs to the service at runtime; this only
  // rejects shapes that could never resolve to a real file.
  if (value.includes(NUL_CHARACTER)) {
    throw new Error("EXPORT_CHROMIUM_PATH must not contain a NUL byte");
  }
  if (!isAbsolute(value)) {
    throw new Error("EXPORT_CHROMIUM_PATH must be an absolute path");
  }

  return value;
}

export function parseExportConfig(environment: Environment): ExportConfig {
  try {
    return Object.freeze({
      chromiumPath: readChromiumPath(environment),
      renderTimeoutMs: readInteger(environment, "EXPORT_RENDER_TIMEOUT_MS", 30_000, 1_000, 300_000),
      maxArtifactBytes: readInteger(
        environment,
        "EXPORT_MAX_ARTIFACT_BYTES",
        26_214_400,
        1_048_576,
        209_715_200,
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid export configuration", error);
  }
}

@Injectable()
export class ExportConfigProvider {
  readonly value = parseExportConfig(process.env);
}

export const exportConfigProvider: Provider<ExportConfig> = {
  provide: EXPORT_CONFIG,
  inject: [ExportConfigProvider],
  useFactory: (provider: ExportConfigProvider): ExportConfig => provider.value,
};
