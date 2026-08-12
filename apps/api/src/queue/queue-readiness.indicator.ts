import { Injectable } from "@nestjs/common";

import { QueueInfrastructureService } from "./queue-infrastructure.service";

import type { ReadinessCheckResult, ReadinessIndicator } from "../health/readiness-indicator";

export const QUEUE_READINESS_INDICATOR = Symbol("QUEUE_READINESS_INDICATOR");

/** Public health seam; Redis clients and BullMQ runtime ownership remain private. */
export interface QueueReadiness extends ReadinessIndicator {
  readonly name: "queue";
}

@Injectable()
export class QueueReadinessIndicator implements QueueReadiness {
  readonly name = "queue" as const;

  constructor(private readonly infrastructure: QueueInfrastructureService) {}

  async check(): Promise<ReadinessCheckResult> {
    const status = this.infrastructure.operationalStatus();
    if (status === "disabled") {
      return { name: this.name, status: "disabled", message: "Queue execution is disabled." };
    }
    if (status === "stopping") {
      return { name: this.name, status: "down", message: "Queue runtime is unavailable." };
    }
    return (await this.infrastructure.probe())
      ? { name: this.name, status: "up" }
      : { name: this.name, status: "down", message: "Queue runtime probe failed." };
  }
}
