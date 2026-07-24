import { Injectable } from "@nestjs/common";

import type { ReadinessCheckResult, ReadinessIndicator } from "./readiness-indicator";

@Injectable()
export class ProcessReadinessIndicator implements ReadinessIndicator {
  readonly name = "api";

  check(): Promise<ReadinessCheckResult> {
    return Promise.resolve({
      name: this.name,
      status: "up",
    });
  }
}
