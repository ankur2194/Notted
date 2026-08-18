import { describe, expect, it } from "vitest";

import { AuthEmailEncryptionService } from "./auth-email-encryption.service";

import type { SecurityConfig } from "../config/security.config";

const config: SecurityConfig = {
  activeEncryptionKeyVersion: 7,
  encryptionKeys: [{ version: 7, encodedKey: Buffer.alloc(32, 17).toString("base64") }],
  maximumUploadBytes: 1_024,
  maximumWorkspaceStorageBytes: 2_048,
  signedUrlTtlSeconds: 60,
  webhookRequestTimeoutMs: 10_000,
  webhookAllowInsecureUrls: false,
};

describe("AuthEmailEncryptionService", () => {
  it("encrypts tokenized URLs with AES-GCM metadata binding", () => {
    const service = new AuthEmailEncryptionService(config);
    const metadata = {
      intentId: "00000000-0000-4000-8000-000000000021",
      purpose: "magic_link" as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const plaintextUrl = "https://app.example.test/magic?token=secret-value";
    const encrypted = service.encrypt({ actionUrl: plaintextUrl }, metadata);
    expect(encrypted.encryptedContext).not.toContain("secret-value");
    expect(encrypted.encryptionKeyVersion).toBe(7);
    expect(service.decrypt(encrypted, metadata)).toEqual({ actionUrl: plaintextUrl });
    expect(() =>
      service.decrypt(encrypted, { ...metadata, purpose: "verification_resend" }),
    ).toThrow();
  });

  it("refuses expired context before decryption", () => {
    const service = new AuthEmailEncryptionService(config);
    const metadata = {
      intentId: "00000000-0000-4000-8000-000000000022",
      purpose: "password_reset_request" as const,
      expiresAt: new Date(Date.now() - 1),
    };
    const encrypted = service.encrypt({ actionUrl: "https://app.example.test/reset" }, metadata);
    expect(() => service.decrypt(encrypted, metadata)).toThrow("expired");
  });
});
