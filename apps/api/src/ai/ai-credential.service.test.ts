import { describe, expect, it } from "vitest";

import { AiCredentialService } from "./ai-credential.service";

import type { SecurityConfig } from "../config/security.config";

const KEY_ONE = { version: 1, encodedKey: Buffer.alloc(32, 7).toString("base64") };
const KEY_TWO = { version: 2, encodedKey: Buffer.alloc(32, 9).toString("base64") };

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

const CONFIG_ID = "70000000-0000-4000-8000-000000000001";
const OTHER_CONFIG_ID = "70000000-0000-4000-8000-000000000002";
const API_KEY = "sk-test-000000000000000000000000000000";

describe("AiCredentialService", () => {
  it("round-trips a provider key under the active key version", () => {
    const service = new AiCredentialService(config(2));
    const stored = service.encrypt(CONFIG_ID, API_KEY);

    expect(stored.encryptionKeyVersion).toBe(2);
    expect(service.activeKeyVersion).toBe(2);
    expect(
      service.decrypt(CONFIG_ID, stored.encryptedCredentials, stored.encryptionKeyVersion),
    ).toBe(API_KEY);
  });

  it("packs nonce, tag and ciphertext into one base64 column without leaking the key", () => {
    const service = new AiCredentialService(config(1));
    const { encryptedCredentials } = service.encrypt(CONFIG_ID, API_KEY);

    expect(encryptedCredentials).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(encryptedCredentials).not.toContain(API_KEY);
    // 12-byte nonce + 16-byte tag before a single byte of ciphertext.
    expect(Buffer.from(encryptedCredentials, "base64").byteLength).toBeGreaterThan(28);
  });

  it("uses a fresh nonce, so the same key never encrypts to the same blob", () => {
    const service = new AiCredentialService(config(1));
    expect(service.encrypt(CONFIG_ID, API_KEY).encryptedCredentials).not.toBe(
      service.encrypt(CONFIG_ID, API_KEY).encryptedCredentials,
    );
  });

  it("binds the blob to its row: another config id cannot decrypt it", () => {
    // Without the AAD binding, a ciphertext copied between rows would bill one
    // workspace's AI usage to a key its admin never supplied.
    const service = new AiCredentialService(config(1));
    const stored = service.encrypt(CONFIG_ID, API_KEY);
    expect(() =>
      service.decrypt(OTHER_CONFIG_ID, stored.encryptedCredentials, stored.encryptionKeyVersion),
    ).toThrow();
  });

  it("rejects a key version that is not configured", () => {
    const service = new AiCredentialService(config(1));
    const stored = service.encrypt(CONFIG_ID, API_KEY);
    expect(() => service.decrypt(CONFIG_ID, stored.encryptedCredentials, 99)).toThrow();
    // Version 2 IS configured, so this fails on the AAD instead — still a
    // refusal, and still without saying which of the two reasons applied.
    expect(() => service.decrypt(CONFIG_ID, stored.encryptedCredentials, 2)).toThrow();
  });

  it("rejects a blob too short to carry a nonce and a tag before slicing it", () => {
    const service = new AiCredentialService(config(1));
    expect(() => service.decrypt(CONFIG_ID, Buffer.alloc(28).toString("base64"), 1)).toThrow();
    expect(() => service.decrypt(CONFIG_ID, "", 1)).toThrow();
  });

  it("never quotes the key, the ciphertext or the config id in a failure", () => {
    const service = new AiCredentialService(config(1));
    const stored = service.encrypt(CONFIG_ID, API_KEY);

    let failure: unknown;
    try {
      service.decrypt(OTHER_CONFIG_ID, stored.encryptedCredentials, stored.encryptionKeyVersion);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toBe("AI credential is unreadable");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(stored.encryptedCredentials);
    expect(message).not.toContain(OTHER_CONFIG_ID);
  });

  it("keeps decrypting an old-version row after the active key moves on", () => {
    // The lazy re-encryption in `AiService.updateConfig` relies on exactly
    // this: read with the ROW's version, write back with the active one.
    const before = new AiCredentialService(config(1));
    const stored = before.encrypt(CONFIG_ID, API_KEY);
    expect(stored.encryptionKeyVersion).toBe(1);

    const after = new AiCredentialService(config(2));
    expect(after.activeKeyVersion).toBe(2);
    expect(after.encrypt(CONFIG_ID, API_KEY).encryptionKeyVersion).toBe(2);
    expect(after.decrypt(CONFIG_ID, stored.encryptedCredentials, stored.encryptionKeyVersion)).toBe(
      API_KEY,
    );
  });
});
