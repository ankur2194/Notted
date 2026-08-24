// Part 67 — the workspace's provider API key at rest.
//
// An admin pastes the key once; from then on only this ciphertext exists.
// `AiGovernanceService` decrypts it immediately before a provider call and
// keeps the plaintext on the stack for the life of that one request, so this is
// reversible encryption rather than a hash — the same situation as
// `webhook-secret.service.ts`, and deliberately the same packed layout, so
// there is one blob format in this codebase to audit rather than two:
//
//     [0 .. 12)   96-bit GCM nonce
//     [12 .. 28)  128-bit GCM authentication tag
//     [28 .. ]    ciphertext
//
// A blob shorter than 28 bytes cannot carry both, so it is rejected before any
// slicing rather than producing a confusing GCM failure.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";

import { AI_CREDENTIAL_AAD_PREFIX } from "./ai.constants";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = NONCE_BYTES + TAG_BYTES;

/**
 * Binds the ciphertext to the config row it lives in AND to the key that wrote
 * it.
 *
 * A blob copied into another workspace's row fails to decrypt instead of
 * quietly billing that workspace's AI usage to a key its admin never supplied.
 * That means the `ai_provider_config` id has to be minted with `randomUUID()`
 * BEFORE the insert, not read back from the column's `DEFAULT` — the id is an
 * input to the encryption, so it cannot be a result of it.
 */
function additionalAuthenticatedData(configId: string, keyVersion: number): Buffer {
  return Buffer.from(`${AI_CREDENTIAL_AAD_PREFIX}:${configId}:${keyVersion}`, "utf8");
}

@Injectable()
export class AiCredentialService {
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(@Inject(SECURITY_CONFIG) private readonly config: SecurityConfig) {
    this.keys = new Map(
      config.encryptionKeys.map(({ version, encodedKey }) => [
        version,
        Buffer.from(encodedKey, "base64"),
      ]),
    );
  }

  /**
   * Exposed so `AiService` can notice a row still sitting on a superseded key
   * and re-encrypt it in place. Without this the only way to migrate a row
   * would be to make an admin paste the key again.
   */
  get activeKeyVersion(): number {
    return this.config.activeEncryptionKeyVersion;
  }

  encrypt(
    configId: string,
    apiKey: string,
  ): { readonly encryptedCredentials: string; readonly encryptionKeyVersion: number } {
    const keyVersion = this.activeKeyVersion;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(keyVersion), nonce);
    cipher.setAAD(additionalAuthenticatedData(configId, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);

    return {
      encryptedCredentials: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
        "base64",
      ),
      encryptionKeyVersion: keyVersion,
    };
  }

  /**
   * Decrypts with the key named by the ROW, not the active key, so rows written
   * before a rotation keep working until `AiService` migrates them on the next
   * configuration write. Both versions must stay in `DATA_ENCRYPTION_KEYS` for
   * that window.
   */
  decrypt(configId: string, encryptedCredentials: string, encryptionKeyVersion: number): string {
    // Resolved before the try so a dropped key version keeps its own message:
    // that is an operator problem (a key removed from `DATA_ENCRYPTION_KEYS`),
    // not a corrupt row, and the two deserve different incident responses.
    const key = this.requireKey(encryptionKeyVersion);
    const packed = Buffer.from(encryptedCredentials, "base64");
    if (packed.byteLength <= HEADER_BYTES) {
      throw new Error("AI credential is unreadable");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, NONCE_BYTES));
      decipher.setAAD(additionalAuthenticatedData(configId, encryptionKeyVersion));
      decipher.setAuthTag(packed.subarray(NONCE_BYTES, HEADER_BYTES));
      return Buffer.concat([
        decipher.update(packed.subarray(HEADER_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Deliberately generic and deliberately swallowing the cause: a message
      // carrying the key, the ciphertext or the config id would end up in a log
      // line or an API error body, which is the entire thing this file exists
      // to prevent.
      throw new Error("AI credential is unreadable");
    }
  }

  private requireKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (key === undefined) {
      throw new Error("AI credential encryption key is unavailable");
    }
    return key;
  }
}
