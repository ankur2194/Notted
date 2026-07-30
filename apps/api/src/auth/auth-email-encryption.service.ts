import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";

import type { AuthEmailPurpose } from "../database/schema";

export interface AuthEmailContext {
  readonly actionUrl?: string;
}

export interface AuthEmailEncryptionMetadata {
  readonly intentId: string;
  readonly purpose: AuthEmailPurpose;
  readonly expiresAt: Date;
}

export interface EncryptedAuthEmailContext {
  readonly encryptedContext: string;
  readonly encryptionKeyVersion: number;
  readonly nonce: string;
  readonly authenticationTag: string;
}

function additionalAuthenticatedData(
  metadata: AuthEmailEncryptionMetadata,
  keyVersion: number,
): Buffer {
  return Buffer.from(
    `notted:auth-email:v1:${metadata.intentId}:${metadata.purpose}:${metadata.expiresAt.toISOString()}:${keyVersion}`,
    "utf8",
  );
}

@Injectable()
export class AuthEmailEncryptionService {
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(@Inject(SECURITY_CONFIG) private readonly config: SecurityConfig) {
    this.keys = new Map(
      config.encryptionKeys.map(({ version, encodedKey }) => [
        version,
        Buffer.from(encodedKey, "base64"),
      ]),
    );
  }

  encrypt(
    context: AuthEmailContext,
    metadata: AuthEmailEncryptionMetadata,
  ): EncryptedAuthEmailContext {
    const keyVersion = this.config.activeEncryptionKeyVersion;
    const key = this.requireKey(keyVersion);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(additionalAuthenticatedData(metadata, keyVersion));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(context), "utf8"),
      cipher.final(),
    ]);

    return {
      encryptedContext: encrypted.toString("base64"),
      encryptionKeyVersion: keyVersion,
      nonce: nonce.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(
    encrypted: EncryptedAuthEmailContext,
    metadata: AuthEmailEncryptionMetadata,
  ): AuthEmailContext {
    if (metadata.expiresAt.getTime() <= Date.now()) {
      throw new Error("Auth email context expired");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.requireKey(encrypted.encryptionKeyVersion),
      Buffer.from(encrypted.nonce, "base64"),
    );
    decipher.setAAD(additionalAuthenticatedData(metadata, encrypted.encryptionKeyVersion));
    decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.encryptedContext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Auth email context is invalid");
    }
    const actionUrl = (parsed as Record<string, unknown>).actionUrl;
    if (actionUrl !== undefined && typeof actionUrl !== "string") {
      throw new Error("Auth email action URL is invalid");
    }
    return actionUrl === undefined ? {} : { actionUrl };
  }

  private requireKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (key === undefined) {
      throw new Error("Auth email encryption key is unavailable");
    }
    return key;
  }
}
