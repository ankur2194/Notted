import { describe, expect, it, vi } from "vitest";

import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { EmailDeliveryQueueHandler } from "./email-delivery.worker.service";

import type { EmailRendererService } from "./email-renderer.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { FeaturesConfig } from "../config/features.config";
import type { DatabaseService } from "../database/database.service";
import type { SmtpService } from "../infrastructure/smtp/smtp.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const DELIVERY_ID = "22222222-0000-4000-8000-000000000002";
const INTENT_ID = "33333333-0000-4000-8000-000000000003";
const NOTE_ID = "44444444-0000-4000-8000-000000000004";
const ACTOR_ID = "55555555-0000-4000-8000-000000000005";
const EXPORT_ID = "66666666-0000-4000-8000-000000000006";

interface DeliveryRow {
  readonly recipient: string;
  readonly templateKey: string;
  readonly status: string;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
}

const mentionRow: DeliveryRow = {
  recipient: "ada@example.test",
  templateKey: "mention",
  status: "queued",
  relatedEntityType: "note",
  relatedEntityId: NOTE_ID,
};

function context(
  overrides: { workspaceId?: string | null; intentId?: string; actorId?: string } = {},
) {
  return {
    outboxIntentId: INTENT_ID,
    // The processor always supplies these; the handler reads them to tell a
    // retryable attempt from the final one.
    attempt: 1,
    maximumAttempts: 3,
    jobType: "email.deliver" as const,
    idempotencyKey: `email:${DELIVERY_ID}`,
    correlationId: undefined,
    signal: new AbortController().signal,
    payload: {
      action: "email.deliver" as const,
      intentId: overrides.intentId ?? INTENT_ID,
      deliveryId: DELIVERY_ID,
      workspaceId: overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
      actorId: overrides.actorId ?? ACTOR_ID,
    },
  };
}

interface UpdateCall {
  readonly values: Record<string, unknown>;
}

/**
 * A `db` whose `select` answers a fixed queue of rows (delivery row, then the
 * branding workspace, then the subject-entity re-reads) and whose `update`
 * records what was written. `claimed` decides whether the claim statement
 * matched a `queued` row.
 */
function fakeDb(options: { rows: readonly (readonly unknown[])[]; claimed: boolean }) {
  const updates: UpdateCall[] = [];
  const rows = [...options.rows];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => rows.shift() ?? [] }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ values });
        const result = {
          // Only the claim statement calls `.returning()`.
          returning: () => Promise.resolve(options.claimed ? [{ id: DELIVERY_ID }] : []),
          then: (resolve: (value: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        };
        return { where: () => result };
      },
    }),
  };
  return { db, updates };
}

function build(
  fake: ReturnType<typeof fakeDb>,
  overrides: { render?: ReturnType<typeof vi.fn>; send?: ReturnType<typeof vi.fn> } = {},
) {
  const authorization = {
    authorizeSystem: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID }),
    run: (_operation: unknown, work: () => unknown) => work(),
  };
  const renderer = {
    render:
      overrides.render ?? vi.fn().mockResolvedValue({ subject: "s", html: "<p>h</p>", text: "t" }),
  };
  const smtp = { send: overrides.send ?? vi.fn().mockResolvedValue("provider-message-id") };
  const logger = { info: vi.fn(), failure: vi.fn() };
  const registry = new QueueHandlerRegistry();
  const handler = new EmailDeliveryQueueHandler(
    { db: fake.db } as unknown as DatabaseService,
    authorization as unknown as AuthorizationEntryService,
    renderer as unknown as EmailRendererService,
    smtp as unknown as SmtpService,
    logger as unknown as StructuredLogger,
    registry,
    {
      appUrl: new URL("https://app.notted.test"),
      apiUrl: new URL("https://api.notted.test"),
    } as AppConfig,
    { emailEnabled: true } as FeaturesConfig,
  );
  return { handler, authorization, renderer, smtp, logger, registry };
}

/** Rows for the happy mention path: delivery, branding workspace, note, actor. */
function mentionRows(row: DeliveryRow = mentionRow): readonly (readonly unknown[])[] {
  return [
    [row],
    [{ name: "Alpha", logoUrl: null, settings: {} }],
    [{ title: "Roadmap" }],
    [{ name: "Ada" }],
  ];
}

/** Rows for the export path: delivery, branding workspace, export, source note. */
function exportRows(
  overrides: { status?: string; relatedEntityType?: string } = {},
): readonly (readonly unknown[])[] {
  return [
    [
      {
        recipient: "ada@example.test",
        templateKey: "export_ready",
        status: "queued",
        relatedEntityType: overrides.relatedEntityType ?? "export",
        relatedEntityId: EXPORT_ID,
      },
    ],
    [{ name: "Alpha", logoUrl: null, settings: {} }],
    [
      {
        format: "txt",
        status: overrides.status ?? "ready",
        sourceId: NOTE_ID,
        signedUrlExpiresAt: null,
      },
    ],
    [{ title: "Roadmap" }],
  ];
}

describe("EmailDeliveryQueueHandler", () => {
  it("registers itself on the shared runtime when email is enabled", () => {
    const subject = build(fakeDb({ rows: mentionRows(), claimed: true }));
    subject.handler.onModuleInit();
    expect(subject.registry.lookup("email.deliver")?.handler).toBe(subject.handler);
    subject.handler.onModuleDestroy();
    expect(subject.registry.lookup("email.deliver")).toBeUndefined();
  });

  it("rejects a payload whose intent id does not match the outbox intent", async () => {
    const fake = fakeDb({ rows: mentionRows(), claimed: true });
    const subject = build(fake);
    await expect(subject.handler.handle(context({ intentId: NOTE_ID }))).rejects.toMatchObject({
      reasonCode: "payload_invalid",
    });
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("fails a delivery id that resolves to no row in this workspace", async () => {
    const fake = fakeDb({ rows: [[]], claimed: true });
    const subject = build(fake);
    await expect(subject.handler.handle(context())).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(subject.authorization.authorizeSystem).not.toHaveBeenCalled();
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("treats a replay of an already sent delivery as a no-op", async () => {
    const fake = fakeDb({
      rows: mentionRows({ ...mentionRow, status: "sent" }),
      claimed: false,
    });
    const subject = build(fake);
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.smtp.send).not.toHaveBeenCalled();
    expect(subject.renderer.render).not.toHaveBeenCalled();
  });

  it("quarantines an interrupted processing row instead of resending it", async () => {
    const fake = fakeDb({
      rows: mentionRows({ ...mentionRow, status: "processing" }),
      claimed: false,
    });
    const subject = build(fake);
    await expect(subject.handler.handle(context())).rejects.toMatchObject({
      reasonCode: "reconciliation_required",
    });
    expect(fake.updates.at(-1)?.values).toEqual({
      status: "reconciliation_required",
      errorMessage: "Interrupted delivery requires reconciliation",
    });
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("authorizes the workspace before touching workspace-owned data", async () => {
    const fake = fakeDb({ rows: mentionRows(), claimed: true });
    const subject = build(fake);
    await subject.handler.handle(context());
    expect(subject.authorization.authorizeSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.read",
        actor: expect.objectContaining({
          kind: "system",
          authorityId: "email-delivery-queue-handler",
          workspaceId: WORKSPACE_ID,
        }),
      }),
    );
  });

  it("records the provider message id and sent timestamp on success", async () => {
    const fake = fakeDb({ rows: mentionRows(), claimed: true });
    const subject = build(fake);
    await subject.handler.handle(context());

    expect(subject.smtp.send).toHaveBeenCalledTimes(1);
    const sent = fake.updates.at(-1)!.values;
    expect(sent.status).toBe("sent");
    expect(sent.providerMessageId).toBe("provider-message-id");
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.errorMessage).toBeNull();
    // Identifiers and outcomes only — never the recipient or the subject.
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: DELIVERY_ID, outcome: "sent" }),
      expect.any(String),
    );
    const [logged] = subject.logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(JSON.stringify(logged)).not.toContain("ada@example.test");
  });

  it("quarantines an ambiguous SMTP failure without a second send", async () => {
    const fake = fakeDb({ rows: mentionRows(), claimed: true });
    const send = vi.fn().mockRejectedValue(new Error("provider outcome unknown"));
    const subject = build(fake, { send });

    await expect(subject.handler.handle(context())).rejects.toMatchObject({
      reasonCode: "reconciliation_required",
    });
    // Exactly one attempt: provider acceptance is ambiguous after a send starts.
    expect(send).toHaveBeenCalledTimes(1);
    const reconciled = fake.updates.at(-1)!.values;
    expect(reconciled.status).toBe("reconciliation_required");
    expect(reconciled.attempts).toBeDefined();
    expect(reconciled.errorMessage).toBe("Provider outcome requires reconciliation");
  });

  it("quarantines a template failure the same way a send failure is quarantined", async () => {
    const fake = fakeDb({ rows: mentionRows(), claimed: true });
    const render = vi.fn().mockRejectedValue(new Error("template exploded"));
    const subject = build(fake, { render });

    await expect(subject.handler.handle(context())).rejects.toMatchObject({
      reasonCode: "reconciliation_required",
    });
    expect(subject.smtp.send).not.toHaveBeenCalled();
    expect(fake.updates.at(-1)!.values.status).toBe("reconciliation_required");
  });

  it("skips authorization for workspace-less system mail", async () => {
    const fake = fakeDb({
      rows: [
        [
          {
            recipient: "ada@example.test",
            templateKey: "welcome",
            status: "queued",
            relatedEntityType: "user",
            relatedEntityId: ACTOR_ID,
          },
        ],
        [{ name: "Ada" }],
      ],
      claimed: true,
    });
    const subject = build(fake);
    await subject.handler.handle(context({ workspaceId: null }));

    expect(subject.authorization.authorizeSystem).not.toHaveBeenCalled();
    expect(subject.renderer.render).toHaveBeenCalledWith(
      "welcome",
      expect.objectContaining({ recipientName: "Ada" }),
    );
    expect(subject.smtp.send).toHaveBeenCalledTimes(1);
  });

  it("refuses a template that keeps its own dedicated pipeline, before claiming", async () => {
    const fake = fakeDb({
      rows: mentionRows({ ...mentionRow, templateKey: "invitation" }),
      claimed: true,
    });
    const subject = build(fake);
    await expect(subject.handler.handle(context())).rejects.toMatchObject({
      reasonCode: "payload_invalid",
    });
    // An unroutable template is a permanent routing error, so the row is never
    // moved to `processing` and never needs reconciling.
    expect(fake.updates).toHaveLength(0);
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });

  it("sends a ready export with a login-gated link and never a signed URL", async () => {
    const fake = fakeDb({ rows: exportRows(), claimed: true });
    const subject = build(fake);
    await subject.handler.handle(context());

    expect(subject.renderer.render).toHaveBeenCalledWith(
      "export_ready",
      expect.objectContaining({ format: "TXT", subjectLabel: "Roadmap" }),
    );
    const [, props] = subject.renderer.render.mock.calls[0] as [string, { exportUrl: string }];
    expect(props.exportUrl).toBe(
      `https://app.notted.test/workspaces/${WORKSPACE_ID}/exports/${EXPORT_ID}`,
    );
    // ADR 0005: a mailbox is persistence. Neither a presigned URL nor the
    // authenticated download route may ever be embedded in a message.
    expect(props.exportUrl).not.toContain("X-Amz-");
    expect(props.exportUrl).not.toContain("/api/v1/");
    expect(subject.smtp.send).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled", "expired"])(
    "refuses to email a dead link for a %s export",
    async (status) => {
      const fake = fakeDb({ rows: exportRows({ status }), claimed: true });
      const subject = build(fake);
      await expect(subject.handler.handle(context())).rejects.toBeInstanceOf(
        PermanentQueueJobError,
      );
      expect(subject.smtp.send).not.toHaveBeenCalled();
    },
  );

  it("refuses an export_ready delivery pointing at a non-export entity", async () => {
    // Raised as `payload_invalid` inside `render`, then quarantined by the
    // shared send guard exactly like a template failure — one send attempt is
    // never made and an operator sees the row.
    const fake = fakeDb({
      rows: exportRows({ relatedEntityType: "note" }),
      claimed: true,
    });
    const subject = build(fake);
    await expect(subject.handler.handle(context())).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(subject.renderer.render).not.toHaveBeenCalled();
    expect(subject.smtp.send).not.toHaveBeenCalled();
  });
});
