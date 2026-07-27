import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { MEILISEARCH_CONFIG, type MeilisearchConfig } from "../../config/meilisearch.config";
import { DependencyState, retryBounded, withTimeout } from "../dependency-lifecycle";

import { MEILISEARCH_CLIENT, type MeilisearchClient } from "./meilisearch.tokens";

import type { ReadinessCheckResult, ReadinessIndicator } from "../../health/readiness-indicator";

@Injectable()
export class MeilisearchService implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown {
  readonly name = "meilisearch";
  private readonly state: DependencyState;

  constructor(
    @Inject(MEILISEARCH_CONFIG) private readonly config: MeilisearchConfig,
    @Inject(MEILISEARCH_CLIENT) private readonly client: MeilisearchClient | null,
    logger: StructuredLogger,
  ) {
    this.state = new DependencyState(this.name, config.enabled, logger);
  }

  async onModuleInit(): Promise<void> {
    if (this.client === null) {
      return;
    }
    try {
      await retryBounded(
        () => this.probe(),
        this.config.startupRetryAttempts,
        this.config.retryDelayMs,
      );
      this.state.transition("up");
    } catch {
      this.state.transition("down");
    }
  }

  async check(): Promise<ReadinessCheckResult> {
    if (this.client === null) {
      return this.state.result();
    }
    try {
      await this.probe();
      this.state.transition("up");
      return this.state.result();
    } catch {
      this.state.transition("down");
      return this.state.result("Meilisearch probe failed");
    }
  }

  onApplicationShutdown(): void {
    this.state.transition("down");
  }

  private async probe(): Promise<void> {
    const health = await withTimeout<{ readonly status: string }>(
      () => this.requireClient().health(),
      this.config.readinessTimeoutMs,
    );
    if (health.status !== "available") {
      throw new Error("Meilisearch is unavailable");
    }
  }

  private requireClient(): MeilisearchClient {
    if (this.client === null) {
      throw new Error("Meilisearch is disabled");
    }
    return this.client;
  }
}
