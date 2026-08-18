// Part 66 — the webhook signing secret at rest.
//
// The raw secret is shown to an admin exactly once (create and rotate) and is
// never retrievable afterwards; only this ciphertext is stored. It is a signing
// key, so the worker needs the plaintext back on every delivery — which is why
// this is reversible encryption and not a hash, unlike `api-key-secret.ts`.
//
// PACKED COLUMN LAYOUT. Unlike `auth-email-encryption.service.ts`, which spends
// three columns, the blob is one base64 `text` column at fixed byte offsets:
//
//     [0 .. 12)   96-bit GCM nonce
//     [12 .. 28)  128-bit GCM authentication tag
//     [28 .. ]    ciphertext
//
// A blob shorter than 28 bytes cannot carry both, so it is rejected before any
// slicing rather than producing a confusing GCM failure.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { WEBHOOK_SECRET_PREFIX } from "@notted/shared-types";

import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";

/** 32 bytes -> exactly 43 base64url characters, 256 bits of entropy. */
const SECRET_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = NONCE_BYTES + TAG_BYTES;

/**
 * Binds the ciphertext to the row it lives in AND to the key that wrote it.
 *
 * A blob copied into another endpoint's row fails to decrypt instead of quietly
 * signing that endpoint's deliveries with a secret its owner never saw. That
 * means the webhook id has to be minted with `randomUUID()` BEFORE the insert,
 * not read back from a `DEFAULT` — the id is an input to the encryption.
 */
function additionalAuthenticatedData(webhookId: string, keyVersion: number): Buffer {
  return Buffer.from(`notted:webhook-secret:v1:${webhookId}:${keyVersion}`, "utf8");
}

@Injectable()
export class WebhookSecretService {
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(@Inject(SECURITY_CONFIG) private readonly config: SecurityConfig) {
    this.keys = new Map(
      config.encryptionKeys.map(({ version, encodedKey }) => [
        version,
        Buffer.from(encodedKey, "base64"),
      ]),
    );
  }

  generate(): string {
    return `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  }

  encrypt(
    webhookId: string,
    secret: string,
  ): { readonly encryptedSecret: string; readonly encryptionKeyVersion: number } {
    const keyVersion = this.config.activeEncryptionKeyVersion;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(keyVersion), nonce);
    cipher.setAAD(additionalAuthenticatedData(webhookId, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

    return {
      encryptedSecret: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"),
      encryptionKeyVersion: keyVersion,
    };
  }

  /**
   * Decrypts with the key named by the ROW, not the active key, so rows written
   * before a rotation keep working. Bulk re-encryption onto the new key is
   * Part 67; until then both versions must stay in `DATA_ENCRYPTION_KEYS`.
   */
  decrypt(webhookId: string, encryptedSecret: string, encryptionKeyVersion: number): string {
    // Resolved before the try so a missing key keeps its own message: the
    // service maps that to `secret_unavailable`, which is an operator problem
    // (a key was dropped from `DATA_ENCRYPTION_KEYS`), not a corrupt row.
    const key = this.requireKey(encryptionKeyVersion);
    const packed = Buffer.from(encryptedSecret, "base64");
    if (packed.byteLength <= HEADER_BYTES) {
      throw new Error("Webhook secret is unreadable");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, NONCE_BYTES));
      decipher.setAAD(additionalAuthenticatedData(webhookId, encryptionKeyVersion));
      decipher.setAuthTag(packed.subarray(NONCE_BYTES, HEADER_BYTES));
      return Buffer.concat([
        decipher.update(packed.subarray(HEADER_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Deliberately generic and deliberately swallowing the cause: a message
      // carrying the secret, the ciphertext or the webhook id would end up in
      // a log line or an API error body.
      throw new Error("Webhook secret is unreadable");
    }
  }

  private requireKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (key === undefined) {
      throw new Error("Webhook secret encryption key is unavailable");
    }
    return key;
  }
}
