import { z } from "zod";

import type { DomainJobType } from "./job-identifiers";
import type { PhysicalQueueName } from "./queue-names";

/** Redis contains only this pointer. Payload version and authority stay in PostgreSQL. */
export const bullJobEnvelopeSchema = z.object({ outboxIntentId: z.string().uuid() }).strict();

export type BullJobEnvelope = z.infer<typeof bullJobEnvelopeSchema>;

const resourceIdsSchema = z.array(z.string().uuid()).min(1).max(8).readonly();

export function identifierPayloadSchema<const TType extends DomainJobType>(jobType: TType) {
  return z
    .object({
      action: z.literal(jobType),
      intentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      resourceIds: resourceIdsSchema,
      actorId: z.string().uuid(),
    })
    .strict();
}

export function platformIdentifierPayloadSchema<const TType extends DomainJobType>(jobType: TType) {
  return z
    .object({
      action: z.literal(jobType),
      intentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      resourceIds: resourceIdsSchema,
      actorId: z.string().uuid().optional(),
    })
    .strict();
}

export function unscopedIdentifierPayloadSchema<const TType extends DomainJobType>(jobType: TType) {
  return z.object({ action: z.literal(jobType), intentId: z.string().uuid() }).strict();
}

export interface QueueRouteMetadata {
  readonly physicalQueueName: PhysicalQueueName;
  readonly deadLetterQueueName: "notted-dead-letter";
  /** High-priority work shares the default lane and uses BullMQ priority. */
  readonly priority: "high" | "default";
  /** Existing logical `job_outbox.queue_name` values accepted for this type. */
  readonly sourceQueueNames: readonly string[];
}

export interface OutboxJobDefinition<
  TType extends DomainJobType = DomainJobType,
  TVersion extends number = number,
  TPayload = unknown,
> {
  readonly jobType: TType;
  readonly payloadVersion: TVersion;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly route: QueueRouteMetadata;
  readonly authority: "actor" | "system";
  /**
   * Per-definition BullMQ attempt budget. Omitted means the global
   * `QUEUE_ATTEMPTS`, which is what every job type shipped before Part 66 used.
   *
   * Webhooks need 5 (Notted.md "max 5 attempts") while the email and mention
   * work they share a lane with stays at 3 — and the budget must be per
   * definition rather than global precisely so ONE dead receiver cannot spend a
   * budget the other job types are also drawing from.
   */
  readonly maximumAttempts?: number;
  /**
   * `"none"` marks a type that no process consumes and none is planned to:
   * the intent is written for durability and for future subscribers, and until
   * one exists the dispatcher must not spend claim budget on it.
   *
   * This is a property of the TYPE, declared here rather than read from
   * `QueueHandlerRegistry`, because the registry is per process. Phase 15 splits
   * the API and worker processes, and a filter driven by one process's
   * registrations would strand — or a retention sweep would cancel — intents the
   * other process handles.
   */
  readonly consumer?: "none";
}

/** Context supplied after Task 50.2 has loaded and validated authoritative intent. */
export interface QueueJobContext<TType extends DomainJobType, TPayload> {
  readonly outboxIntentId: string;
  readonly jobType: TType;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly payload: TPayload;
  /** Aborted when the worker's wait budget expires; handlers should pass it to cancellable adapters. */
  readonly signal: AbortSignal;
  /**
   * 1-based attempt number of the CURRENT invocation, read from the BullMQ job
   * the processor already holds — no extra bookkeeping.
   *
   * A handler that classifies its own failures ("retry this, record that as
   * terminal") cannot settle cleanly without knowing it is on the last attempt:
   * it would either dead-letter work that had one try left, or re-throw on the
   * final attempt and lose the terminal outcome it wanted to record. Every
   * handler written before Part 66 ignores both fields.
   */
  readonly attempt: number;
  readonly maximumAttempts: number;
}

export interface QueueJobHandler<TType extends DomainJobType, TPayload> {
  readonly jobType: TType;
  handle(context: QueueJobContext<TType, TPayload>): Promise<void>;
}

export type AnyOutboxJobDefinition = OutboxJobDefinition<DomainJobType, number, unknown>;

/** Typed binding Task 50.2 can collect without weakening payloads to `any`. */
export interface QueueJobRegistration<TDefinition extends AnyOutboxJobDefinition> {
  readonly definition: TDefinition;
  readonly handler: QueueJobHandler<TDefinition["jobType"], z.output<TDefinition["payloadSchema"]>>;
}

export function defineOutboxJob<
  const TType extends DomainJobType,
  const TVersion extends number,
  TPayload,
>(definition: OutboxJobDefinition<TType, TVersion, TPayload>): typeof definition {
  return Object.freeze({
    ...definition,
    route: Object.freeze({
      ...definition.route,
      sourceQueueNames: Object.freeze([...definition.route.sourceQueueNames]),
    }),
  });
}

export function defineQueueJobRegistration<TDefinition extends AnyOutboxJobDefinition>(
  registration: QueueJobRegistration<TDefinition>,
): QueueJobRegistration<TDefinition> {
  return Object.freeze(registration);
}
