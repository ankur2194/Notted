import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { isRegisteredOutboxRoute } from "./job-registry";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";
import { QueueInfrastructureService } from "./queue-infrastructure.service";
import { QueueOutboxRepository } from "./queue-outbox.repository";
import { deadLetterRecordSchema, type OutboxRuntimeRow } from "./queue-runtime.types";

@Injectable()
export class OutboxDispatcherService {
  private accepting = true;

  constructor(
    private readonly repository: QueueOutboxRepository,
    private readonly handlers: QueueHandlerRegistry,
    private readonly infrastructure: QueueInfrastructureService,
  ) {}

  stopClaiming(): void {
    this.accepting = false;
  }

  async dispatchOnce(batchSize: number, staleClaimMs: number): Promise<void> {
    if (!this.accepting) return;
    const rows = await this.repository.claimBatch(batchSize, staleClaimMs);
    for (const row of rows) {
      if (!this.accepting) {
        await this.repository.releaseUnhandled(row.id, staleClaimMs);
        continue;
      }
      const binding = this.handlers.lookup(row.jobType);
      // Unknown definitions and known definitions without a concrete consumer
      // remain durable pending intent. This is the rollout safety gate.
      if (binding === undefined) {
        await this.repository.releaseUnhandled(row.id, staleClaimMs);
        continue;
      }
      if (!isRegisteredOutboxRoute(binding.definition, row.queueName, row.payloadVersion)) {
        await this.repository.releaseUnhandled(row.id, staleClaimMs);
        continue;
      }
      const parsed = binding.definition.payloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await this.repository.markFailed(row, "payload_invalid");
        await this.publishPermanentFailure(
          row,
          binding.definition.route.physicalQueueName,
          "payload_invalid",
        );
        continue;
      }
      const hash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
      if (hash !== row.payloadHash) {
        await this.repository.markFailed(row, "payload_hash_mismatch");
        await this.publishPermanentFailure(
          row,
          binding.definition.route.physicalQueueName,
          "payload_hash_mismatch",
        );
        continue;
      }

      // add(jobId=outbox ID) is idempotent. If publish succeeds and this update
      // fails, stale-claim recovery repeats add and then converges PostgreSQL.
      await this.infrastructure.publish(row.id, binding);
      await this.repository.markDispatched(row.id);
    }
  }

  private async publishPermanentFailure(
    row: OutboxRuntimeRow,
    sourceQueue: string,
    reasonCode: "payload_hash_mismatch" | "payload_invalid",
  ): Promise<void> {
    await this.infrastructure.publishDeadLetter(
      deadLetterRecordSchema.parse({
        sourceQueue,
        outboxIntentId: row.id,
        jobType: row.jobType,
        reasonCode,
        attempts: 1,
        failedAt: new Date().toISOString(),
        correlationId: row.correlationId ?? undefined,
      }),
    );
  }
}
