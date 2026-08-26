import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { QUEUE_CONFIG, type QueueConfig } from "../config/queue.config";
import { queueJobDurationSeconds } from "../metrics/metrics.registry";

import { bullJobEnvelopeSchema } from "./job-contracts";
import { isRegisteredOutboxRoute } from "./job-registry";
import { PermanentQueueJobError, QueueRuntimeError, type QueueFailureCode } from "./queue-errors";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";
import {
  QueueInfrastructureService,
  type QueueWorkerInvocation,
} from "./queue-infrastructure.service";
import { QueueOutboxRepository } from "./queue-outbox.repository";
import { deadLetterRecordSchema, type OutboxRuntimeRow } from "./queue-runtime.types";

/** Two decimal places, matching `RequestContextMiddleware`'s HTTP duration. */
const elapsedMs = (startedAt: number): number =>
  Math.round((performance.now() - startedAt) * 100) / 100;

@Injectable()
export class QueueWorkerProcessorService {
  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
    private readonly repository: QueueOutboxRepository,
    private readonly handlers: QueueHandlerRegistry,
    private readonly infrastructure: QueueInfrastructureService,
    private readonly logger: StructuredLogger,
  ) {}

  async process(invocation: QueueWorkerInvocation): Promise<void> {
    // ONE clock reading for two consumers: the duration histogram below and the
    // `durationMs` field on both log lines. Before Part 78 the worker logged a
    // completion and a failure with no duration at all, so "jobs are slow" had
    // no evidence anywhere — and taking a second `performance.now()` for the log
    // would let the two numbers disagree about the same job.
    const startedAt = performance.now();
    const envelope = bullJobEnvelopeSchema.safeParse(invocation.envelope);
    const fallbackId = typeof invocation.bullJobId === "string" ? invocation.bullJobId : undefined;
    const outboxId = envelope.success ? envelope.data.outboxIntentId : fallbackId;
    const row = outboxId === undefined ? undefined : await this.repository.load(outboxId);
    if (
      !envelope.success ||
      row === undefined ||
      envelope.data.outboxIntentId !== invocation.bullJobId
    ) {
      if (row !== undefined) await this.finalizeFailure(row, invocation, "envelope_invalid");
      throw new UnrecoverableError("envelope_invalid");
    }
    if (row.status === "completed") return;
    if (row.status !== "dispatching" && row.status !== "dispatched") {
      await this.finalizeFailure(row, invocation, "intent_invalid");
      throw new UnrecoverableError("intent_invalid");
    }

    try {
      await this.validateAndHandle(row, invocation);
      const durationMs = elapsedMs(startedAt);
      queueJobDurationSeconds.observe(
        { queue: invocation.sourceQueue, outcome: "completed" },
        durationMs / 1_000,
      );
      this.logger.info(
        {
          queue: invocation.sourceQueue,
          jobId: row.id,
          correlationId: row.correlationId ?? undefined,
          outcome: "completed",
          durationMs,
        },
        "Queue job completed",
      );
    } catch (error: unknown) {
      const runtimeError = this.safeRuntimeError(error);
      const finalAttempt = invocation.attempt >= invocation.maximumAttempts;
      if (
        runtimeError.reasonCode === "processor_timeout" ||
        runtimeError.reasonCode === "reconciliation_required"
      ) {
        await this.repository.requireReconciliation(row, runtimeError.reasonCode);
        await this.publishFailure(row, invocation, runtimeError.reasonCode);
      } else if (runtimeError.permanent || finalAttempt) {
        await this.finalizeFailure(row, invocation, runtimeError.reasonCode);
      } else {
        await this.repository.releaseExecution(row, runtimeError.reasonCode);
        await this.repository.recordRetry(row.id, runtimeError.reasonCode);
      }
      const outcome = runtimeError.permanent || finalAttempt ? "failed" : "retry";
      const durationMs = elapsedMs(startedAt);
      queueJobDurationSeconds.observe(
        { queue: invocation.sourceQueue, outcome },
        durationMs / 1_000,
      );
      this.logger.failure(
        {
          queue: invocation.sourceQueue,
          jobId: row.id,
          correlationId: row.correlationId ?? undefined,
          outcome,
          reason: runtimeError.reasonCode,
        },
        "Queue job attempt failed",
      );
      if (runtimeError.permanent || runtimeError.reasonCode === "processor_timeout") {
        throw new UnrecoverableError(runtimeError.reasonCode);
      }
      throw runtimeError;
    }
  }

  private async validateAndHandle(
    row: OutboxRuntimeRow,
    invocation: QueueWorkerInvocation,
  ): Promise<void> {
    const binding = this.handlers.lookup(row.jobType);
    if (binding === undefined) throw new QueueRuntimeError("handler_missing", false);
    if (binding.definition.route.physicalQueueName !== invocation.sourceQueue) {
      throw new QueueRuntimeError("route_invalid", true);
    }
    if (binding.definition.payloadVersion !== row.payloadVersion) {
      throw new QueueRuntimeError("version_unsupported", true);
    }
    if (!isRegisteredOutboxRoute(binding.definition, row.queueName, row.payloadVersion)) {
      throw new QueueRuntimeError("route_invalid", true);
    }
    const parsed = binding.definition.payloadSchema.safeParse(row.payload);
    if (!parsed.success) throw new QueueRuntimeError("payload_invalid", true);
    const hash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    if (hash !== row.payloadHash) throw new QueueRuntimeError("payload_hash_mismatch", true);

    try {
      const claim = await this.repository.claimExecution(row, this.config.idempotencyRetentionDays);
      if (claim === "completed") return;
      if (claim === "reconciliation_required") {
        throw new QueueRuntimeError("reconciliation_required", true);
      }
      const abort = new AbortController();
      await this.withTimeout(
        binding.handler.handle({
          outboxIntentId: row.id,
          jobType: binding.definition.jobType,
          idempotencyKey: row.idempotencyKey,
          correlationId: row.correlationId ?? undefined,
          payload: parsed.data,
          signal: abort.signal,
          attempt: invocation.attempt,
          maximumAttempts: invocation.maximumAttempts,
        }),
        this.config.workers[invocation.sourceQueue].timeoutMs,
        abort,
      );
      await this.repository.completeExecution(row);
    } catch (error: unknown) {
      if (error instanceof PermanentQueueJobError) {
        throw new QueueRuntimeError(error.reasonCode, true);
      }
      if (error instanceof QueueRuntimeError) throw error;
      if (error instanceof Error && error.message === "QUEUE_IDEMPOTENCY_HASH_MISMATCH") {
        throw new QueueRuntimeError("payload_hash_mismatch", true);
      }
      throw new QueueRuntimeError("handler_failed", false);
    }
  }

  /** Timeout aborts cooperative work; uncancellable work is quarantined for reconciliation. */
  private async withTimeout(
    work: Promise<void>,
    timeoutMs: number,
    abort: AbortController,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort(new Error("Queue processor timeout"));
        reject(new QueueRuntimeError("processor_timeout", true));
      }, timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private safeRuntimeError(error: unknown): QueueRuntimeError {
    return error instanceof QueueRuntimeError
      ? error
      : error instanceof PermanentQueueJobError
        ? new QueueRuntimeError(error.reasonCode, true)
        : new QueueRuntimeError("handler_failed", false);
  }

  private async finalizeFailure(
    row: OutboxRuntimeRow,
    invocation: QueueWorkerInvocation,
    reasonCode: QueueFailureCode,
  ): Promise<void> {
    await this.repository.markFailed(row, reasonCode);
    await this.publishFailure(row, invocation, reasonCode);
  }

  private async publishFailure(
    row: OutboxRuntimeRow,
    invocation: QueueWorkerInvocation,
    reasonCode: QueueFailureCode,
  ): Promise<void> {
    const record = deadLetterRecordSchema.parse({
      sourceQueue: invocation.sourceQueue,
      outboxIntentId: row.id,
      jobType: row.jobType,
      reasonCode,
      attempts: invocation.attempt,
      failedAt: new Date().toISOString(),
      correlationId: row.correlationId ?? undefined,
    });
    await this.infrastructure.publishDeadLetter(record);
  }
}
