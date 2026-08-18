import { describe, expect, it, vi } from "vitest";

import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { AuthEmailQueueHandler } from "./auth-email-worker.service";

import type { AuthEmailEncryptionService } from "./auth-email-encryption.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { FeaturesConfig } from "../config/features.config";
import type { DatabaseService } from "../database/database.service";
import type { EmailRendererService } from "../email/email-renderer.service";
import type { SmtpService } from "../infrastructure/smtp/smtp.service";

const intentId = "00000000-0000-4000-8000-000000000021";
const deliveryId = "00000000-0000-4000-8000-000000000022";

const appConfig = { appUrl: new URL("https://app.notted.test") } as AppConfig;

/** Renders the fixed shape the handler consumes; never touches React. */
function renderer(
  render = vi.fn().mockResolvedValue({ subject: "s", html: "<p>h</p>", text: "t" }),
): { readonly renderer: EmailRendererService; readonly render: typeof render } {
  return { renderer: { render } as unknown as EmailRendererService, render };
}

function context() {
  return {
    outboxIntentId: "00000000-0000-4000-8000-000000000023",
    jobType: "deliver-auth-email" as const,
    idempotencyKey: `auth-email:${intentId}`,
    signal: new AbortController().signal,
    payload: { action: "deliver-auth-email" as const, intentId },
  };
}

function features(): FeaturesConfig {
  return { emailEnabled: true } as FeaturesConfig;
}

describe("AuthEmailQueueHandler", () => {
  it("registers the canonical shared-runtime handler and skips a terminal delivery", async () => {
    const row = {
      intent: { id: intentId, status: "sent", expiresAt: new Date(Date.now() + 60_000) },
      delivery: { id: deliveryId },
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => [row] }) }) }),
        }),
      },
    };
    const encryption = { decrypt: vi.fn() };
    const smtp = { send: vi.fn() };
    const registry = new QueueHandlerRegistry();
    const handler = new AuthEmailQueueHandler(
      database as unknown as DatabaseService,
      encryption as unknown as AuthEmailEncryptionService,
      renderer().renderer,
      smtp as unknown as SmtpService,
      { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
      registry,
      appConfig,
      features(),
    );

    handler.onModuleInit();
    expect(registry.lookup("deliver-auth-email")?.handler).toBe(handler);
    await handler.handle(context());
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(smtp.send).not.toHaveBeenCalled();
    handler.onModuleDestroy();
    expect(registry.lookup("deliver-auth-email")).toBeUndefined();
  });

  it("marks ambiguous SMTP rejection for reconciliation so a retry cannot resend", async () => {
    let status: "pending" | "processing" | "failed" = "pending";
    const intent = {
      id: intentId,
      status,
      purpose: "magic_link" as const,
      expiresAt: new Date(Date.now() + 60_000),
      encryptedContext: "ciphertext",
      encryptionKeyVersion: 1,
      nonce: "nonce",
      authenticationTag: "tag",
    };
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => [
                {
                  intent: { ...intent, status },
                  delivery: { id: deliveryId, recipient: "u@example.test" },
                },
              ],
            }),
          }),
        }),
      }),
      update: () => ({
        set: (value: { status?: string }) => {
          if (value.status === "processing" || value.status === "failed") status = value.status;
          return {
            where: () => ({
              returning: () => {
                return [{ id: intentId }];
              },
              then: (resolve: (value: unknown) => unknown) => resolve(undefined),
            }),
          };
        },
      }),
    };
    const database = {
      db,
      transaction: <T>(work: (tx: typeof db) => Promise<T>) => work(db),
    };
    const smtp = { send: vi.fn().mockRejectedValue(new Error("ambiguous provider result")) };
    const template = renderer();
    const handler = new AuthEmailQueueHandler(
      database as unknown as DatabaseService,
      {
        decrypt: vi.fn().mockReturnValue({ actionUrl: "https://example.test/secret" }),
      } as unknown as AuthEmailEncryptionService,
      template.renderer,
      smtp as unknown as SmtpService,
      { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
      new QueueHandlerRegistry(),
      appConfig,
      features(),
    );

    await expect(handler.handle(context())).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(status).toBe("failed");
    // The purpose IS the template key, and auth mail is workspace-less, so it
    // renders with platform branding.
    expect(template.render).toHaveBeenCalledWith("magic_link", {
      branding: expect.objectContaining({ name: "Notted", logoUrl: null }),
      actionUrl: "https://example.test/secret",
    });
    await expect(handler.handle(context())).resolves.toBeUndefined();
    expect(smtp.send).toHaveBeenCalledTimes(1);
  });

  it("quarantines a template failure without ever handing anything to the provider", async () => {
    let status: "pending" | "processing" | "failed" = "pending";
    const set = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => [
                {
                  intent: {
                    id: intentId,
                    status,
                    purpose: "magic_link" as const,
                    expiresAt: new Date(Date.now() + 60_000),
                    encryptedContext: "ciphertext",
                    encryptionKeyVersion: 1,
                    nonce: "nonce",
                    authenticationTag: "tag",
                  },
                  delivery: { id: deliveryId, recipient: "u@example.test" },
                },
              ],
            }),
          }),
        }),
      }),
      update: () => ({
        set: (value: { status?: string; attempts?: unknown }) => {
          set(value);
          if (value.status === "processing" || value.status === "failed") status = value.status;
          return {
            where: () => ({
              returning: () => [{ id: intentId }],
              then: (resolve: (value: unknown) => unknown) => resolve(undefined),
            }),
          };
        },
      }),
    };
    const database = { db, transaction: <T>(work: (tx: typeof db) => Promise<T>) => work(db) };
    const smtp = { send: vi.fn() };
    const handler = new AuthEmailQueueHandler(
      database as unknown as DatabaseService,
      {
        decrypt: vi.fn().mockReturnValue({ actionUrl: "https://example.test/secret" }),
      } as unknown as AuthEmailEncryptionService,
      renderer(vi.fn().mockRejectedValue(new Error("template bug"))).renderer,
      smtp as unknown as SmtpService,
      { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
      new QueueHandlerRegistry(),
      appConfig,
      features(),
    );

    await expect(handler.handle(context())).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(status).toBe("failed");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reconciliation_required" }),
    );
    // No send was attempted, so no attempt may be counted against the delivery.
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ attempts: expect.anything() }));
    expect(smtp.send).not.toHaveBeenCalled();
  });
});
