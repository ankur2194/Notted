import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { MINIO_CONFIG, type MinioConfig } from "../../config/minio.config";
import { DependencyState, retryBounded, withTimeout } from "../dependency-lifecycle";

import { MINIO_AGENT, MINIO_CLIENT } from "./minio.tokens";

import type { ReadinessCheckResult, ReadinessIndicator } from "../../health/readiness-indicator";
import type { Client } from "minio";
import type { Agent } from "node:http";

@Injectable()
export class MinioService implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown {
  readonly name = "minio";
  private readonly state: DependencyState;

  constructor(
    @Inject(MINIO_CONFIG) private readonly config: MinioConfig,
    @Inject(MINIO_CLIENT) private readonly client: Client | null,
    @Inject(MINIO_AGENT) private readonly agent: Agent | null,
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

  async bucketExists(bucket: "attachments" | "exports"): Promise<boolean> {
    const name =
      bucket === "attachments" ? this.config.attachmentsBucket : this.config.exportsBucket;
    return this.requireClient().bucketExists(name);
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
      return this.state.result("MinIO probe failed");
    }
  }

  onApplicationShutdown(): void {
    this.state.transition("down");
    this.agent?.destroy();
  }

  private async probe(): Promise<void> {
    const [attachments, exports] = await withTimeout(
      () => Promise.all([this.bucketExists("attachments"), this.bucketExists("exports")]),
      this.config.readinessTimeoutMs,
    );
    if (!attachments || !exports) {
      throw new Error("required MinIO bucket is unavailable");
    }
  }

  private requireClient(): Client {
    if (this.client === null) {
      throw new Error("MinIO is disabled");
    }
    return this.client;
  }
}
