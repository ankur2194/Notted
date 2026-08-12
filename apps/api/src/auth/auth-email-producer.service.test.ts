import { describe, expect, it } from "vitest";

import { DatabaseService } from "../database/database.service";

import { AuthEmailEncryptionService } from "./auth-email-encryption.service";
import { AuthEmailProducerService } from "./auth-email-producer.service";

describe("AuthEmailProducerService", () => {
  it("commits delivery, encrypted context and identifier-only outbox before dispatch", async () => {
    const events: string[] = [];
    const values: unknown[] = [];
    const tx = {
      insert: () => ({
        values: (value: unknown) => {
          values.push(value);
          return Promise.resolve();
        },
      }),
    };
    const database = {
      transaction: async (work: (scope: typeof tx) => Promise<void>) => {
        await work(tx);
        events.push("commit");
      },
    };
    const encryption = {
      encrypt: () => ({
        encryptedContext: "ciphertext",
        encryptionKeyVersion: 1,
        nonce: "bm9uY2U=",
        authenticationTag: "dGFn",
      }),
    };
    const producer = new AuthEmailProducerService(
      database as unknown as DatabaseService,
      encryption as unknown as AuthEmailEncryptionService,
    );
    await producer.queue({
      recipient: "USER@example.test",
      purpose: "magic_link",
      context: { actionUrl: "https://example.test/?token=plaintext" },
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(events).toEqual(["commit"]);
    expect(JSON.stringify(values)).not.toContain("plaintext");
    const outbox = values.at(-1) as { payload: Record<string, unknown> };
    expect(Object.keys(outbox.payload).sort()).toEqual(["action", "intentId"]);
  });
});
