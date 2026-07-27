import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readInteger, readString, wrapConfigError } from "./environment-readers";

export const SECURITY_CONFIG = Symbol("SECURITY_CONFIG");

export interface EncryptionKey {
  readonly version: number;
  readonly encodedKey: string;
}

export interface SecurityConfig {
  readonly activeEncryptionKeyVersion: number;
  readonly encryptionKeys: readonly EncryptionKey[];
  readonly maximumUploadBytes: number;
  readonly maximumWorkspaceStorageBytes: number;
  readonly signedUrlTtlSeconds: number;
}

const DEVELOPMENT_KEY = "1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function readEncryptionKeys(
  environment: Environment,
  production: boolean,
): readonly EncryptionKey[] {
  const raw = readString(
    environment,
    "DATA_ENCRYPTION_KEYS",
    production ? undefined : DEVELOPMENT_KEY,
  );
  const versions = new Set<number>();
  const keys = raw.split(",").map((entry): EncryptionKey => {
    const separator = entry.indexOf(":");
    const versionText = entry.slice(0, separator);
    const encodedKey = entry.slice(separator + 1);
    if (!/^[1-9]\d*$/u.test(versionText) || encodedKey === "") {
      throw new Error("DATA_ENCRYPTION_KEYS must use version:base64 entries");
    }
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || versions.has(version)) {
      throw new Error("DATA_ENCRYPTION_KEYS versions must be unique positive integers");
    }
    versions.add(version);
    const decoded = Buffer.from(encodedKey, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== encodedKey) {
      throw new Error("every DATA_ENCRYPTION_KEYS value must decode to exactly 32 bytes");
    }
    if (production && (decoded.every((byte) => byte === 0) || entry === DEVELOPMENT_KEY)) {
      throw new Error("DATA_ENCRYPTION_KEYS must not use a placeholder production key");
    }
    return Object.freeze({ version, encodedKey });
  });
  if (keys.length === 0) {
    throw new Error("DATA_ENCRYPTION_KEYS must contain at least one key");
  }
  return Object.freeze(keys);
}

export function parseSecurityConfig(environment: Environment): SecurityConfig {
  try {
    const production = environment.NODE_ENV === "production";
    const encryptionKeys = readEncryptionKeys(environment, production);
    return Object.freeze({
      activeEncryptionKeyVersion: encryptionKeys[0]!.version,
      encryptionKeys,
      maximumUploadBytes: readInteger(
        environment,
        "MAX_UPLOAD_SIZE_BYTES",
        50 * 1_024 * 1_024,
        1_024,
        2 * 1_024 * 1_024 * 1_024,
      ),
      maximumWorkspaceStorageBytes: readInteger(
        environment,
        "MAX_WORKSPACE_STORAGE_BYTES",
        10 * 1_024 * 1_024 * 1_024,
        1_024,
        Number.MAX_SAFE_INTEGER,
      ),
      signedUrlTtlSeconds: readInteger(environment, "SIGNED_URL_TTL_SECONDS", 900, 60, 86_400),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid security configuration", error);
  }
}

@Injectable()
export class SecurityConfigProvider {
  readonly value = parseSecurityConfig(process.env);
}

export const securityConfigProvider: Provider<SecurityConfig> = {
  provide: SECURITY_CONFIG,
  inject: [SecurityConfigProvider],
  useFactory: (provider: SecurityConfigProvider): SecurityConfig => provider.value,
};
