import { describe, expect, it } from "vitest";

import { bullJobEnvelopeSchema } from "./job-contracts";
import { DOMAIN_JOB_TYPES } from "./job-identifiers";
import { isRegisteredOutboxRoute, registeredJobDefinition } from "./job-registry";
import { PHYSICAL_QUEUE_NAMES } from "./queue-names";

describe("queue contracts", () => {
  it("keeps the Redis envelope identifier-only", () => {
    expect(
      bullJobEnvelopeSchema.parse({ outboxIntentId: "00000000-0000-4000-8000-000000000001" }),
    ).toEqual({ outboxIntentId: "00000000-0000-4000-8000-000000000001" });
    expect(() =>
      bullJobEnvelopeSchema.parse({
        outboxIntentId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
  });

  it("routes only a registered type, source queue, and version", () => {
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.noteUpdated);
    expect(definition?.route.physicalQueueName).toBe(PHYSICAL_QUEUE_NAMES.default);
    expect(definition && isRegisteredOutboxRoute(definition, "note-domain-events", 1)).toBe(true);
    expect(definition && isRegisteredOutboxRoute(definition, "historical-events", 1)).toBe(false);
    expect(definition && isRegisteredOutboxRoute(definition, "note-domain-events", 2)).toBe(false);
    expect(registeredJobDefinition("unknown.historical.type")).toBeUndefined();
  });

  it("uses BullMQ priority rather than a fifth physical queue", () => {
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.deliverAuthEmail);
    expect(Object.keys(PHYSICAL_QUEUE_NAMES)).toHaveLength(4);
    expect(definition?.route).toMatchObject({
      physicalQueueName: PHYSICAL_QUEUE_NAMES.default,
      priority: "high",
    });
  });

  it("strictly validates authoritative PostgreSQL payloads", () => {
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.workspaceDeleted);
    const payload = {
      action: DOMAIN_JOB_TYPES.workspaceDeleted,
      intentId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      resourceIds: ["00000000-0000-4000-8000-000000000002"],
      secret: "must-not-cross-boundary",
    };
    expect(() => definition?.payloadSchema.parse(payload)).toThrow();
  });

  it("registers note-version retention as strict unscoped system maintenance", () => {
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.noteVersionRetentionSweep);
    expect(definition).toMatchObject({
      authority: "system",
      payloadVersion: 1,
      route: { physicalQueueName: PHYSICAL_QUEUE_NAMES.maintenance },
    });
    expect(
      definition?.payloadSchema.parse({
        action: DOMAIN_JOB_TYPES.noteVersionRetentionSweep,
        intentId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toBeDefined();
    expect(() =>
      definition?.payloadSchema.parse({
        action: DOMAIN_JOB_TYPES.noteVersionRetentionSweep,
        intentId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
  });
});
