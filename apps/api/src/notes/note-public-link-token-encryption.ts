// Reversible encryption for a note public-link token, so its owner can
// re-copy the link at any time without regenerating it. Mirrors
// `webhook-secret.service.ts` exactly — same AES-256-GCM construction, same
// `SecurityConfig.encryptionKeys`/`activeEncryptionKeyVersion` rotation
// infrastructure, same packed-column layout (nonce, auth tag, ciphertext) —
// as plain functions rather than a service, matching `note-public-link-token.ts`'s
// own shape (pure, config passed in as a parameter).
//
// The AAD binds ciphertext to the NOTE it belongs to, not the link row: a
// blob copied into another note's row fails to decrypt instead of quietly
// handing back a URL for a note its holder was never granted.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { SecurityConfig } from "../config/security.config";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = NONCE_BYTES + TAG_BYTES;

function additionalAuthenticatedData(noteId: string, keyVersion: number): Buffer {
  return Buffer.from(`notted:note-public-link-token:v1:${noteId}:${keyVersion}`, "utf8");
}

function requireKey(config: SecurityConfig, version: number): Buffer {
  const entry = config.encryptionKeys.find((key) => key.version === version);
  if (entry === undefined) throw new Error("Public link encryption key is unavailable");
  return Buffer.from(entry.encodedKey, "base64");
}

export function encryptPublicLinkToken(
  config: SecurityConfig,
  noteId: string,
  rawToken: string,
): { readonly encryptedToken: string; readonly encryptionKeyVersion: number } {
  const keyVersion = config.activeEncryptionKeyVersion;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", requireKey(config, keyVersion), nonce);
  cipher.setAAD(additionalAuthenticatedData(noteId, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
  return {
    encryptedToken: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"),
    encryptionKeyVersion: keyVersion,
  };
}

/**
 * Deliberately generic on failure: a message carrying the ciphertext, the
 * note id, or a key-lookup detail would end up in a log line or an API error
 * body. Same rule `webhook-secret.service.ts` follows.
 */
export function decryptPublicLinkToken(
  config: SecurityConfig,
  noteId: string,
  encryptedToken: string,
  encryptionKeyVersion: number,
): string {
  const key = requireKey(config, encryptionKeyVersion);
  const packed = Buffer.from(encryptedToken, "base64");
  if (packed.byteLength <= HEADER_BYTES) throw new Error("Public link token is unreadable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, NONCE_BYTES));
    decipher.setAAD(additionalAuthenticatedData(noteId, encryptionKeyVersion));
    decipher.setAuthTag(packed.subarray(NONCE_BYTES, HEADER_BYTES));
    return Buffer.concat([
      decipher.update(packed.subarray(HEADER_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Public link token is unreadable");
  }
}
