import { describe, expect, it, vi } from "vitest";

import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { InvitationEmailQueueHandler } from "./invitation-email-worker.service";

import type { InvitationTokenService } from "./invitation-token.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { FeaturesConfig } from "../config/features.config";
import type { DatabaseService } from "../database/database.service";
import type { EmailRendererService } from "../email/email-renderer.service";
import type { SmtpService } from "../infrastructure/smtp/smtp.service";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000002";
const deliveryId = "30000000-0000-4000-8000-000000000003";

function context(overrides: { workspaceId?: string; resourceIds?: readonly string[] } = {}) {
  return {
    outboxIntentId: "30000000-0000-4000-8000-000000000004",
    // The processor always supplies these; the handler reads them to tell a
    // retryable attempt from the final one.
    attempt: 1,
    maximumAttempts: 3,
    jobType: "workspace.invitation.send" as const,
    idempotencyKey: `workspace-invitation-send:${invitationId}`,
    signal: new AbortController().signal,
    payload: {
      action: "workspace.invitation.send" as const,
      intentId: "30000000-0000-4000-8000-000000000004",
      workspaceId: overrides.workspaceId ?? workspaceId,
      resourceIds: overrides.resourceIds ?? [invitationId, deliveryId],
      actorId: "30000000-0000-4000-8000-000000000005",
    },
  };
}

function build(database: unknown) {
  const tenant = new TenantContextService();
  const authorization = {
    authorizeSystem: vi.fn().mockResolvedValue({ workspaceId }),
    run: (_operation: unknown, work: () => unknown) =>
      tenant.run(createTenantContext({ workspaceId, userId: null }), work),
  };
  const smtp = { send: vi.fn() };
  const tokens = { derive: vi.fn() };
  const render = vi
    .fn()
    .mockResolvedValue({ subject: "Join Alpha on Notted", html: "<p>h</p>", text: "t" });
  const registry = new QueueHandlerRegistry();
  const handler = new InvitationEmailQueueHandler(
    database as DatabaseService,
    authorization as unknown as AuthorizationEntryService,
    tenant,
    tokens as unknown as InvitationTokenService,
    { render } as unknown as EmailRendererService,
    smtp as unknown as SmtpService,
    { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
    registry,
    { appUrl: new URL("https://app.notted.test") } as AppConfig,
    { emailEnabled: true } as FeaturesConfig,
  );
  return { handler, authorization, smtp, tokens, render, registry };
}

describe("InvitationEmailQueueHandler", () => {
  it("rejects malformed resource identifiers before loading tenant data", async () => {
    const database = { db: { select: vi.fn() } };
    const subject = build(database);
    await expect(
      subject.handler.handle(context({ resourceIds: [invitationId] })),
    ).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(database.db.select).not.toHaveBeenCalled();
  });

  it("fails cross-workspace payload tampering without authorizing or sending", async () => {
    const database = {
      db: {
        select: () => ({
          from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => [] }) }) }),
        }),
      },
    };
    const subject = build(database);
    await expect(subject.handler.handle(context())).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(subject.authorization.authorizeSystem).not.toHaveBeenCalled();
    expect(subject.tokens.derive).not.toHaveBeenCalled();
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("rechecks pending delivery state under tenant context and treats duplicates as no-ops", async () => {
    const claimTx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => [
                  { deliveryStatus: "sent", recipient: "u@example.test", workspaceName: "Alpha" },
                ],
              }),
            }),
          }),
        }),
      }),
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({ where: () => ({ limit: () => [{ workspaceId }] }) }),
          }),
        }),
      },
      transaction: (work: (tx: typeof claimTx) => unknown) => work(claimTx),
    };
    const subject = build(database);
    subject.handler.onModuleInit();
    expect(subject.registry.lookup("workspace.invitation.send")?.handler).toBe(subject.handler);
    await subject.handler.handle(context());
    expect(subject.authorization.authorizeSystem).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ workspaceId }) }),
    );
    expect(subject.tokens.derive).not.toHaveBeenCalled();
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("moves a processing delivery to reconciliation after restart without resending", async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const claimTx = {
      execute: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnValue({ set }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => [
                  {
                    deliveryStatus: "processing",
                    recipient: "u@example.test",
                    workspaceName: "Alpha",
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({ where: () => ({ limit: () => [{ workspaceId }] }) }),
          }),
        }),
      },
      transaction: (work: (tx: typeof claimTx) => unknown) => work(claimTx),
    };
    const subject = build(database);
    await subject.handler.handle(context());
    expect(set).toHaveBeenCalledWith({
      status: "reconciliation_required",
      errorMessage: "Interrupted delivery requires reconciliation",
    });
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("quarantines an ambiguous SMTP acceptance timeout instead of making it retryable", async () => {
    const claimSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const reconcileSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const claimTx = {
      execute: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnValue({ set: claimSet }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => [
                  {
                    deliveryStatus: "queued",
                    recipient: "u@example.test",
                    workspaceName: "Alpha",
                    workspaceLogoUrl: null,
                    workspaceSettings: null,
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({ where: () => ({ limit: () => [{ workspaceId }] }) }),
          }),
        }),
        update: vi.fn().mockReturnValue({ set: reconcileSet }),
      },
      transaction: (work: (tx: typeof claimTx) => unknown) => work(claimTx),
    };
    const subject = build(database);
    subject.tokens.derive.mockReturnValue("opaque-token");
    subject.smtp.send.mockRejectedValue(new Error("provider outcome unknown"));
    await expect(subject.handler.handle(context())).rejects.toMatchObject({
      reasonCode: "reconciliation_required",
    });
    expect(claimSet).toHaveBeenCalledWith({ status: "processing", errorMessage: null });
    expect(reconcileSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reconciliation_required" }),
    );
    expect(subject.smtp.send).toHaveBeenCalledTimes(1);
  });

  it("sends the rendered invitation template with workspace branding", async () => {
    const claimTx = {
      execute: vi.fn().mockResolvedValue(undefined),
      update: vi
        .fn()
        .mockReturnValue({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => [
                  {
                    deliveryStatus: "queued",
                    recipient: "u@example.test",
                    workspaceName: "Alpha",
                    workspaceLogoUrl: "https://cdn.notted.test/alpha.png",
                    workspaceSettings: { accentColor: "#ff0000" },
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({ where: () => ({ limit: () => [{ workspaceId }] }) }),
          }),
        }),
        update: vi
          .fn()
          .mockReturnValue({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
      },
      transaction: (work: (tx: typeof claimTx) => unknown) => work(claimTx),
    };
    const subject = build(database);
    subject.tokens.derive.mockReturnValue("opaque-token");
    subject.smtp.send.mockResolvedValue("provider-message-id");

    await subject.handler.handle(context());

    // Branding comes from the columns the claim already selected — no extra query.
    expect(subject.render).toHaveBeenCalledWith("invitation", {
      branding: expect.objectContaining({
        name: "Alpha",
        logoUrl: "https://cdn.notted.test/alpha.png",
        accentColor: "#ff0000",
      }),
      workspaceName: "Alpha",
      actionUrl: "https://app.notted.test/invitations/accept?token=opaque-token",
    });
    // The subject is unchanged by the migration; the body is the rendered one.
    expect(subject.smtp.send).toHaveBeenCalledWith({
      to: "u@example.test",
      subject: "Join Alpha on Notted",
      html: "<p>h</p>",
      text: "t",
    });
  });
});
