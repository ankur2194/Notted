import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { ExportGenerationService } from "./export-generation.service";
import { ExportGenerationWorkerService } from "./export.worker.service";
import { NoteExportSourceService } from "./note-export-source.service";

import type { ExportClaim, ExportService } from "./export.service";
import type { PdfExportService } from "./pdf-export.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";
import type { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import type { ObjectStorageService } from "../infrastructure/minio/object-storage.service";
import type { NotificationService } from "../notifications/notification.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const EXPORT_ID = "22222222-0000-4000-8000-000000000002";
const INTENT_ID = "33333333-0000-4000-8000-000000000003";
const NOTE_ID = "44444444-0000-4000-8000-000000000004";
const REQUESTER_ID = "55555555-0000-4000-8000-000000000005";

const claim: ExportClaim = {
  id: EXPORT_ID,
  workspaceId: WORKSPACE_ID,
  requestedById: REQUESTER_ID,
  format: "txt",
  sourceType: "note",
  sourceId: NOTE_ID,
  options: {
    includeAttachments: false,
    includeComments: false,
    includeVersionHistory: false,
    headerText: null,
    footerText: null,
    margins: null,
  },
};

const noteRow = {
  title: "Roadmap",
  content: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
  },
  isDeleted: false,
};

function context(overrides: { intentId?: string } = {}) {
  return {
    outboxIntentId: INTENT_ID,
    jobType: "export.generate" as const,
    idempotencyKey: `export:${EXPORT_ID}`,
    correlationId: undefined,
    signal: new AbortController().signal,
    payload: {
      action: "export.generate" as const,
      intentId: overrides.intentId ?? INTENT_ID,
      workspaceId: WORKSPACE_ID,
      exportId: EXPORT_ID,
      requestedById: REQUESTER_ID,
    },
  };
}

function denial(): AuthorizationDeniedError {
  return new AuthorizationDeniedError({
    allowed: false,
    code: "authorization.concealed",
    httpStatus: 404,
    safeMessage: "The requested resource was not found.",
    audit: {
      action: "note.read",
      actorKind: "user",
      resourceKind: "note",
      outcome: "deny",
      reason: "concealed",
    },
  });
}

/**
 * A `db` whose `select` answers a fixed queue of rows (the source note, then
 * the requester's address) and whose `transaction` runs the callback inline.
 */
function fakeDb(rows: readonly (readonly unknown[])[]) {
  const remaining = [...rows];
  return {
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => remaining.shift() ?? [] }) }),
      }),
    },
    transaction: (work: (tx: unknown) => Promise<unknown>) => work({}),
  };
}

interface BuildOverrides {
  readonly rows?: readonly (readonly unknown[])[];
  readonly claim?: ExportClaim | null;
  readonly markReady?: boolean;
  readonly authorizeUserJob?: ReturnType<typeof vi.fn>;
  readonly putObject?: ReturnType<typeof vi.fn>;
  readonly removeObject?: ReturnType<typeof vi.fn>;
  readonly emit?: ReturnType<typeof vi.fn>;
  readonly queue?: ReturnType<typeof vi.fn>;
}

function build(overrides: BuildOverrides = {}) {
  const database = fakeDb(overrides.rows ?? [[noteRow], [{ email: "ada@example.test" }]]);
  const exports = {
    claim: vi.fn().mockResolvedValue(overrides.claim === undefined ? claim : overrides.claim),
    markReady: vi.fn().mockResolvedValue(overrides.markReady ?? true),
    markFailed: vi.fn().mockResolvedValue(true),
  };
  const objects = {
    putObject: overrides.putObject ?? vi.fn().mockResolvedValue({ etag: "etag" }),
    removeObject: overrides.removeObject ?? vi.fn().mockResolvedValue(undefined),
  };
  const notifications = { emit: overrides.emit ?? vi.fn().mockResolvedValue(undefined) };
  const emailProducer = {
    queue:
      overrides.queue ?? vi.fn().mockResolvedValue({ deliveryId: EXPORT_ID, outcome: "queued" }),
  };
  const authorization = {
    authorizeSystem: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, userId: null }),
    run: (_operation: unknown, work: () => unknown) => work(),
    authorizeUserJob: overrides.authorizeUserJob ?? vi.fn().mockResolvedValue({}),
  };
  const registry = new QueueHandlerRegistry();
  const logger = { info: vi.fn(), warning: vi.fn(), failure: vi.fn() };
  const handler = new ExportGenerationWorkerService(
    database as unknown as DatabaseService,
    exports as unknown as ExportService,
    // The real service: the `txt` path these suites exercise is pure, so a stub
    // would only prove the stub. The two collaborators are stubbed because they
    // serve the arms this suite does not drive — `pdf` needs Chromium and `zip`
    // needs authorized note reads, and each has its own fully mocked unit tests.
    new ExportGenerationService(
      { render: vi.fn() } as unknown as PdfExportService,
      { load: vi.fn(), readObject: vi.fn() } as unknown as NoteExportSourceService,
      { chromiumPath: null, renderTimeoutMs: 30_000, maxArtifactBytes: 26_214_400 },
    ),
    objects as unknown as ObjectStorageService,
    notifications as unknown as NotificationService,
    emailProducer as unknown as WorkspaceEmailProducerService,
    authorization as unknown as AuthorizationEntryService,
    registry,
    logger as unknown as StructuredLogger,
  );
  return {
    handler,
    exports,
    objects,
    notifications,
    emailProducer,
    authorization,
    registry,
    logger,
  };
}

/** Every argument handed to every logger method, flattened for leak checks. */
function loggedPayload(logger: ReturnType<typeof build>["logger"]): string {
  return JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warning.mock.calls,
    ...logger.failure.mock.calls,
  ]);
}

describe("ExportGenerationWorkerService", () => {
  it("registers itself on the shared runtime", () => {
    const subject = build();
    subject.handler.onModuleInit();
    expect(subject.registry.lookup("export.generate")?.handler).toBe(subject.handler);
    subject.handler.onModuleDestroy();
    expect(subject.registry.lookup("export.generate")).toBeUndefined();
  });

  it("rejects a payload whose intent id does not match the outbox intent", async () => {
    const subject = build();
    await expect(subject.handler.handle(context({ intentId: NOTE_ID }))).rejects.toMatchObject({
      reasonCode: "payload_invalid",
    });
    expect(subject.exports.claim).not.toHaveBeenCalled();
  });

  it("opens a finite system authority, never a wildcard", async () => {
    const subject = build();
    await subject.handler.handle(context());
    expect(subject.authorization.authorizeSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.read",
        actor: expect.objectContaining({
          kind: "system",
          authorityId: "export-generation-worker",
          workspaceId: WORKSPACE_ID,
          allowedActions: ["workspace.read"],
          allowedResourceKinds: ["workspace"],
        }),
      }),
    );
  });

  it("treats a lost claim as a replay and does nothing at all", async () => {
    const subject = build({ claim: null });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.objects.putObject).not.toHaveBeenCalled();
    expect(subject.exports.markReady).not.toHaveBeenCalled();
    expect(subject.exports.markFailed).not.toHaveBeenCalled();
    expect(subject.notifications.emit).not.toHaveBeenCalled();
    expect(subject.emailProducer.queue).not.toHaveBeenCalled();
  });

  it("fails cleanly when the source note was soft-deleted", async () => {
    const subject = build({ rows: [[{ ...noteRow, isDeleted: true }]] });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markFailed).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      exportId: EXPORT_ID,
      errorCode: "source_unavailable",
    });
    expect(subject.objects.putObject).not.toHaveBeenCalled();
  });

  it("fails cleanly when the source note is gone entirely", async () => {
    const subject = build({ rows: [[]] });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "source_unavailable" }),
    );
    expect(subject.objects.putObject).not.toHaveBeenCalled();
  });

  it("fails cleanly when the requester lost access to the source", async () => {
    const subject = build({
      authorizeUserJob: vi.fn().mockRejectedValue(denial()),
    });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markFailed).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      exportId: EXPORT_ID,
      errorCode: "source_forbidden",
    });
    expect(subject.objects.putObject).not.toHaveBeenCalled();
  });

  it("propagates a non-authorization failure from the re-check", async () => {
    const subject = build({
      authorizeUserJob: vi.fn().mockRejectedValue(new Error("policy store unreachable")),
    });
    await expect(subject.handler.handle(context())).rejects.toThrow("policy store unreachable");
    expect(subject.exports.markFailed).not.toHaveBeenCalled();
  });

  it("records storage_unavailable without dead-lettering when the upload fails", async () => {
    const subject = build({
      putObject: vi.fn().mockRejectedValue(new Error("minio down")),
    });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "storage_unavailable" }),
    );
    expect(subject.exports.markReady).not.toHaveBeenCalled();
  });

  it("uploads and marks ready, then announces", async () => {
    const subject = build();
    await subject.handler.handle(context());

    const [bucket, key, body] = subject.objects.putObject.mock.calls[0] as [string, string, Buffer];
    expect(bucket).toBe("exports");
    expect(key).toBe(`${WORKSPACE_ID}/${EXPORT_ID}.txt`);
    expect(subject.exports.markReady).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      exportId: EXPORT_ID,
      objectKey: key,
      byteLength: body.byteLength,
    });
    expect(subject.notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "export",
        targetType: "export",
        targetId: EXPORT_ID,
        recipientUserId: REQUESTER_ID,
        actorUserId: null,
      }),
    );
    expect(subject.emailProducer.queue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        templateKey: "export_ready",
        relatedEntityType: "export",
        relatedEntityId: EXPORT_ID,
      }),
    );
  });

  it("never puts the object key or the note title in a log line", async () => {
    const subject = build();
    await subject.handler.handle(context());
    const logged = loggedPayload(subject.logger);
    expect(logged).not.toContain(`${WORKSPACE_ID}/${EXPORT_ID}.txt`);
    expect(logged).not.toContain(".txt");
    expect(logged).not.toContain("Roadmap");
  });

  it("skips both side effects when the ready transition lost a race", async () => {
    const subject = build({ markReady: false });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.notifications.emit).not.toHaveBeenCalled();
    expect(subject.emailProducer.queue).not.toHaveBeenCalled();
  });

  it("deletes the uploaded artefact when the ready transition lost a race", async () => {
    // `markReady` is the ONLY writer of `exports.object_key`, so a lost race
    // leaves the row terminal with a NULL key — and the Part 45 sweep selects
    // on `isNotNull(objectKey)`, so it can never reclaim these bytes. Without
    // this deletion every cancel-during-upload leaks one artefact permanently.
    const subject = build({ markReady: false });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();

    const uploaded = subject.objects.putObject.mock.calls[0] as [string, string, Buffer];
    expect(subject.objects.removeObject).toHaveBeenCalledWith("exports", uploaded[1]);
  });

  it("stays successful when the orphan cleanup itself fails", async () => {
    // The row is already terminal; a failed cleanup must not fail the job or
    // resurrect anything. It is reported and nothing else.
    const subject = build({
      markReady: false,
      removeObject: vi.fn().mockRejectedValue(new Error("minio down")),
    });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.logger.failure).toHaveBeenCalled();
    expect(subject.exports.markFailed).not.toHaveBeenCalled();
  });

  it("does not delete anything when the export completed normally", async () => {
    const subject = build();
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markReady).toHaveBeenCalled();
    expect(subject.objects.removeObject).not.toHaveBeenCalled();
  });

  it("keeps the export ready when the in-app notification fails", async () => {
    const subject = build({ emit: vi.fn().mockRejectedValue(new Error("insert failed")) });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markReady).toHaveBeenCalled();
    expect(subject.exports.markFailed).not.toHaveBeenCalled();
    expect(subject.logger.warning).toHaveBeenCalled();
  });

  it("keeps the export ready when the email intent fails", async () => {
    const subject = build({ queue: vi.fn().mockRejectedValue(new Error("smtp misconfigured")) });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markReady).toHaveBeenCalled();
    expect(subject.exports.markFailed).not.toHaveBeenCalled();
    expect(subject.logger.warning).toHaveBeenCalled();
  });

  it("refuses a source shape the create path never produces", async () => {
    const subject = build({
      claim: { ...claim, sourceType: "workspace", sourceId: null },
    });
    await expect(subject.handler.handle(context())).resolves.toBeUndefined();
    expect(subject.exports.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "format_unsupported" }),
    );
    expect(subject.authorization.authorizeUserJob).not.toHaveBeenCalled();
  });
});
