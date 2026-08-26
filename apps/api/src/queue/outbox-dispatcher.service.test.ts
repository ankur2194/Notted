import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DOMAIN_JOB_TYPES } from "./job-identifiers";
import { isUnconsumedJobType, registeredJobDefinition } from "./job-registry";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";

import type { QueueInfrastructureService } from "./queue-infrastructure.service";
import type { QueueOutboxRepository } from "./queue-outbox.repository";
import type { OutboxRuntimeRow } from "./queue-runtime.types";

const OUTBOX_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const RESOURCE_ID = "30000000-0000-4000-8000-000000000001";
const ACTOR_ID = "40000000-0000-4000-8000-000000000001";

function row(overrides: Partial<OutboxRuntimeRow> = {}): OutboxRuntimeRow {
  const payload = {
    action: DOMAIN_JOB_TYPES.noteCreated,
    intentId: OUTBOX_ID,
    workspaceId: WORKSPACE_ID,
    resourceIds: [RESOURCE_ID],
    actorId: ACTOR_ID,
  };
  return {
    id: OUTBOX_ID,
    queueName: "note-domain-events",
    jobType: DOMAIN_JOB_TYPES.noteCreated,
    payloadVersion: 1,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    idempotencyKey: "note-created:test",
    status: "dispatching",
    attemptCount: 0,
    correlationId: null,
    ...overrides,
  };
}

function setup(claimed: readonly OutboxRuntimeRow[]) {
  const repository = {
    claimBatch: vi.fn().mockResolvedValue(claimed),
    releaseUnhandled: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markDispatched: vi.fn().mockResolvedValue(undefined),
  };
  const infrastructure = {
    publish: vi.fn().mockResolvedValue(undefined),
    publishDeadLetter: vi.fn().mockResolvedValue(undefined),
  };
  const handlers = new QueueHandlerRegistry();
  const dispatcher = new OutboxDispatcherService(
    repository as unknown as QueueOutboxRepository,
    handlers,
    infrastructure as unknown as QueueInfrastructureService,
  );
  return { dispatcher, handlers, infrastructure, repository };
}

describe("OutboxDispatcherService", () => {
  it("keeps a known historical intent pending until a concrete handler registers", async () => {
    // `workspace.deleted`, NOT one of the `consumer: "none"` domain events: the
    // rollout safety gate applies to a type whose consumer is still to be
    // deployed, and the claim query now excludes the marked types before the
    // dispatcher ever sees them.
    const payload = {
      action: DOMAIN_JOB_TYPES.workspaceDeleted,
      intentId: OUTBOX_ID,
      workspaceId: WORKSPACE_ID,
      resourceIds: [RESOURCE_ID],
      actorId: ACTOR_ID,
    };
    const context = setup([
      row({
        queueName: "workspace-cleanup",
        jobType: DOMAIN_JOB_TYPES.workspaceDeleted,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      }),
    ]);
    expect(isUnconsumedJobType(DOMAIN_JOB_TYPES.workspaceDeleted)).toBe(false);
    await context.dispatcher.dispatchOnce(10, 30_000);
    expect(context.repository.releaseUnhandled).toHaveBeenCalledWith(OUTBOX_ID, 30_000);
    expect(context.infrastructure.publish).not.toHaveBeenCalled();
  });

  it("republicates a stale dispatched row with the stable Bull job ID after Redis flush/restart", async () => {
    const context = setup([row({ status: "dispatched" })]);
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.noteCreated);
    if (definition === undefined) throw new Error("test definition missing");
    context.handlers.register({
      definition,
      handler: { jobType: definition.jobType, handle: vi.fn() },
    });

    await context.dispatcher.dispatchOnce(10, 30_000);
    await context.dispatcher.dispatchOnce(10, 30_000);
    expect(context.infrastructure.publish).toHaveBeenCalledTimes(2);
    expect(context.infrastructure.publish).toHaveBeenNthCalledWith(
      1,
      OUTBOX_ID,
      expect.any(Object),
    );
    expect(context.infrastructure.publish).toHaveBeenNthCalledWith(
      2,
      OUTBOX_ID,
      expect.any(Object),
    );
    expect(context.repository.markDispatched).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid payloads and payload hash tampering before Redis publication", async () => {
    const invalidPayload = row({ payload: { action: DOMAIN_JOB_TYPES.noteCreated } });
    const invalidHash = row({ payloadHash: "0".repeat(64) });
    const context = setup([invalidPayload, invalidHash]);
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.noteCreated);
    if (definition === undefined) throw new Error("test definition missing");
    context.handlers.register({
      definition,
      handler: { jobType: definition.jobType, handle: vi.fn() },
    });

    await context.dispatcher.dispatchOnce(10, 30_000);
    expect(context.repository.markFailed).toHaveBeenCalledWith(invalidPayload, "payload_invalid");
    expect(context.repository.markFailed).toHaveBeenCalledWith(
      invalidHash,
      "payload_hash_mismatch",
    );
    expect(context.infrastructure.publish).not.toHaveBeenCalled();
    expect(context.infrastructure.publishDeadLetter).toHaveBeenCalledTimes(2);
  });
});
