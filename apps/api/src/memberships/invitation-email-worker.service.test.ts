import { describe, expect, it, vi } from "vitest";

import { invitations } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { InvitationEmailWorkerService } from "./invitation-email-worker.service";

import type { InvitationTokenService } from "./invitation-token.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { AuthEmailQueueConfig } from "../config/auth-email-queue.config";
import type { DatabaseService } from "../database/database.service";
import type { SmtpService } from "../infrastructure/smtp/smtp.service";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000002";
const deliveryId = "30000000-0000-4000-8000-000000000003";

function config(): AuthEmailQueueConfig {
  return {
    queueName: "auth-email",
    payloadVersion: 1,
    dispatcherIntervalMs: 1_000,
    concurrency: 1,
    attempts: 3,
    retryBackoffMs: 1_000,
    idempotencyRetentionDays: 7,
  };
}

function authorization(tenant: TenantContextService) {
  return {
    authorizeSystem: vi.fn().mockResolvedValue({ workspaceId }),
    run: (_operation: unknown, work: () => unknown) =>
      tenant.run(createTenantContext({ workspaceId, userId: null }), work),
  };
}

function updateChain() {
  return { set: () => ({ where: () => Promise.resolve() }) };
}

describe("InvitationEmailWorkerService", () => {
  it("derives the token only after a pending claim and records no raw token", async () => {
    const tenant = new TenantContextService();
    const inserted: unknown[] = [];
    const claimTx = {
      execute: () => Promise.resolve(),
      select: () => ({
        from: (table: unknown) =>
          table === invitations
            ? {
                innerJoin: () => ({
                  innerJoin: () => ({
                    where: () => ({
                      limit: () =>
                        Promise.resolve([
                          {
                            recipient: "invitee@example.test",
                            deliveryStatus: "queued",
                            workspaceName: "Alpha & Co",
                          },
                        ]),
                    }),
                  }),
                }),
              }
            : { where: () => ({ limit: () => Promise.resolve([]) }) },
      }),
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return Promise.resolve();
        },
      }),
      update: updateChain,
    };
    const finalTx = { update: updateChain };
    const database = {
      db: {
        select: () => ({
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ workspaceId }]) }) }),
        }),
      },
      transaction: vi
        .fn()
        .mockImplementationOnce((work: (tx: typeof claimTx) => unknown) => work(claimTx))
        .mockImplementationOnce((work: (tx: typeof finalTx) => unknown) => work(finalTx)),
    };
    const tokens = { derive: vi.fn().mockReturnValue("raw-invitation-token") };
    const smtp = { send: vi.fn().mockResolvedValue("mailpit-message-id") };
    const logger = { info: vi.fn(), failure: vi.fn() };
    const worker = new InvitationEmailWorkerService(
      database as unknown as DatabaseService,
      authorization(tenant) as unknown as AuthorizationEntryService,
      tenant,
      tokens as unknown as InvitationTokenService,
      smtp as unknown as SmtpService,
      logger as unknown as StructuredLogger,
      { appUrl: new URL("https://app.notted.test") } as AppConfig,
      config(),
    );

    await worker.process({ invitationId, deliveryId }, false);

    expect(tokens.derive).toHaveBeenCalledWith(invitationId);
    expect(smtp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "invitee@example.test",
        subject: "Join Alpha & Co on Notted",
        text: expect.stringContaining("raw-invitation-token"),
      }),
    );
    expect(JSON.stringify(inserted)).not.toContain("raw-invitation-token");
  });

  it("cancels a stale invitation without deriving or sending a token", async () => {
    const tenant = new TenantContextService();
    const claimTx = {
      execute: () => Promise.resolve(),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
          }),
        }),
      }),
      update: updateChain,
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ workspaceId }]) }) }),
        }),
      },
      transaction: vi.fn((work: (tx: typeof claimTx) => unknown) => work(claimTx)),
    };
    const tokens = { derive: vi.fn() };
    const smtp = { send: vi.fn() };
    const worker = new InvitationEmailWorkerService(
      database as unknown as DatabaseService,
      authorization(tenant) as unknown as AuthorizationEntryService,
      tenant,
      tokens as unknown as InvitationTokenService,
      smtp as unknown as SmtpService,
      { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
      { appUrl: new URL("https://app.notted.test") } as AppConfig,
      config(),
    );

    await worker.process({ invitationId, deliveryId }, false);

    expect(tokens.derive).not.toHaveBeenCalled();
    expect(smtp.send).not.toHaveBeenCalled();
  });
});
