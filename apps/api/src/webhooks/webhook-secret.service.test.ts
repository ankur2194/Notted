import { describe, expect, it } from "vitest";

import { WebhookSecretService } from "./webhook-secret.service";

import type { SecurityConfig } from "../config/security.config";

const KEY_ONE = { version: 1, encodedKey: Buffer.alloc(32, 11).toString("base64") };
const KEY_TWO = { version: 2, encodedKey: Buffer.alloc(32, 22).toString("base64") };

function config(activeEncryptionKeyVersion: number): SecurityConfig {
  return {
    activeEncryptionKeyVersion,
    encryptionKeys: [KEY_ONE, KEY_TWO],
    maximumUploadBytes: 1_024,
    maximumWorkspaceStorageBytes: 2_048,
    signedUrlTtlSeconds: 60,
    webhookRequestTimeoutMs: 10_000,
    webhookAllowInsecureUrls: false,
  };
}

const WEBHOOK_ID = "00000000-0000-4000-8000-000000000066";
const OTHER_WEBHOOK_ID = "00000000-0000-4000-8000-000000000067";

describe("WebhookSecretService.generate", () => {
  it("emits the published wire format", () => {
    expect(new WebhookSecretService(config(1)).generate()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
  });

  it("never repeats a secret", () => {
    const service = new WebhookSecretService(config(1));
    const secrets = new Set(Array.from({ length: 50 }, () => service.generate()));
    expect(secrets.size).toBe(50);
  });
});

describe("WebhookSecretService encryption", () => {
  it("round-trips a secret under the active key", () => {
    const service = new WebhookSecretService(config(2));
    const secret = service.generate();
    const stored = service.encrypt(WEBHOOK_ID, secret);

    expect(stored.encryptionKeyVersion).toBe(2);
    expect(service.decrypt(WEBHOOK_ID, stored.encryptedSecret, stored.encryptionKeyVersion)).toBe(
      secret,
    );
  });

  it("packs nonce, tag and ciphertext into one base64 column without leaking the plaintext", () => {
    const service = new WebhookSecretService(config(1));
    const secret = service.generate();
    const { encryptedSecret } = service.encrypt(WEBHOOK_ID, secret);

    expect(encryptedSecret).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(encryptedSecret).not.toContain(secret);
    expect(encryptedSecret).not.toContain(secret.slice("whsec_".length));
    // 12-byte nonce + 16-byte tag before a single byte of ciphertext.
    expect(Buffer.from(encryptedSecret, "base64").byteLength).toBeGreaterThan(28);
  });

  it("uses a fresh nonce, so the same secret never encrypts to the same blob", () => {
    const service = new WebhookSecretService(config(1));
    const secret = service.generate();
    expect(service.encrypt(WEBHOOK_ID, secret).encryptedSecret).not.toBe(
      service.encrypt(WEBHOOK_ID, secret).encryptedSecret,
    );
  });

  it("binds the blob to its row: another endpoint's id cannot decrypt it", () => {
    // Without the AAD binding, a ciphertext copied between rows would silently
    // sign the other endpoint's deliveries with a secret its owner never saw.
    const service = new WebhookSecretService(config(1));
    const stored = service.encrypt(WEBHOOK_ID, service.generate());
    expect(() =>
      service.decrypt(OTHER_WEBHOOK_ID, stored.encryptedSecret, stored.encryptionKeyVersion),
    ).toThrow();
  });

  it("rejects an unknown key version", () => {
    const service = new WebhookSecretService(config(1));
    const stored = service.encrypt(WEBHOOK_ID, service.generate());
    expect(() => service.decrypt(WEBHOOK_ID, stored.encryptedSecret, 99)).toThrow();
  });

  it("rejects a blob too short to carry a nonce and a tag", () => {
    const service = new WebhookSecretService(config(1));
    expect(() => service.decrypt(WEBHOOK_ID, Buffer.alloc(27).toString("base64"), 1)).toThrow();
    expect(() => service.decrypt(WEBHOOK_ID, "", 1)).toThrow();
  });

  it("never quotes the secret, the ciphertext or the webhook id in a failure", () => {
    const service = new WebhookSecretService(config(1));
    const secret = service.generate();
    const stored = service.encrypt(WEBHOOK_ID, secret);

    let failure: unknown;
    try {
      service.decrypt(OTHER_WEBHOOK_ID, stored.encryptedSecret, stored.encryptionKeyVersion);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).not.toContain(secret);
    expect(message).not.toContain(stored.encryptedSecret);
    expect(message).not.toContain(OTHER_WEBHOOK_ID);
  });

  it("keeps decrypting an old-version row after the active key moves on", () => {
    // Rotation adds a key; bulk re-encryption is Part 67, so rows written under
    // the previous version must keep working in the meantime.
    const before = new WebhookSecretService(config(1));
    const secret = before.generate();
    const stored = before.encrypt(WEBHOOK_ID, secret);
    expect(stored.encryptionKeyVersion).toBe(1);

    const after = new WebhookSecretService(config(2));
    expect(after.encrypt(WEBHOOK_ID, secret).encryptionKeyVersion).toBe(2);
    expect(after.decrypt(WEBHOOK_ID, stored.encryptedSecret, stored.encryptionKeyVersion)).toBe(
      secret,
    );
  });
});
