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

  it("gives webhook delivery its own 5-attempt budget without touching its lane mates", () => {
    const webhook = registeredJobDefinition(DOMAIN_JOB_TYPES.webhookDeliver);
    expect(webhook).toMatchObject({
      authority: "system",
      maximumAttempts: 5,
      route: { physicalQueueName: PHYSICAL_QUEUE_NAMES.default },
    });
    // The budget is per definition precisely so one dead receiver cannot spend
    // the attempts belonging to the email and mention work sharing that lane:
    // those carry no override and fall back to the global QUEUE_ATTEMPTS.
    expect(
      registeredJobDefinition(DOMAIN_JOB_TYPES.deliverWorkspaceEmail)?.maximumAttempts,
    ).toBeUndefined();
    expect(
      registeredJobDefinition(DOMAIN_JOB_TYPES.mentionNotify)?.maximumAttempts,
    ).toBeUndefined();
  });

  it("carries occurredAt but nothing else beyond identifiers on a webhook intent", () => {
    const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.webhookDeliver);
    const payload = {
      action: DOMAIN_JOB_TYPES.webhookDeliver,
      intentId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      webhookId: "00000000-0000-4000-8000-000000000003",
      eventId: "00000000-0000-4000-8000-000000000004",
      event: "note.deleted",
      resourceId: null,
      actorId: null,
      occurredAt: "2026-08-18T10:00:00.000Z",
    };
    expect(definition?.payloadSchema.parse(payload)).toEqual(payload);
    // A body, a title, or anything else the receiver might want is rebuilt from
    // authoritative state by the handler, never carried across the boundary.
    expect(() => definition?.payloadSchema.parse({ ...payload, title: "leaked" })).toThrow();
    expect(() =>
      definition?.payloadSchema.parse({ ...payload, occurredAt: "yesterday" }),
    ).toThrow();
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
