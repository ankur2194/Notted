import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { MEILISEARCH_CONFIG, type MeilisearchConfig } from "../../config/meilisearch.config";
import { DependencyState, retryBounded, withTimeout } from "../dependency-lifecycle";

import {
  MEILISEARCH_CLIENT,
  type MeilisearchClient,
  type MeilisearchDocumentsPage,
  type MeilisearchIndex,
  type MeilisearchTask,
  type MeilisearchTaskReference,
} from "./meilisearch.tokens";

import type { ReadinessCheckResult, ReadinessIndicator } from "../../health/readiness-indicator";

@Injectable()
export class MeilisearchService implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown {
  readonly name = "meilisearch";
  private readonly state: DependencyState;

  constructor(
    @Inject(MEILISEARCH_CONFIG) private readonly config: MeilisearchConfig,
    @Inject(MEILISEARCH_CLIENT) private readonly client: MeilisearchClient | null,
    @Inject(StructuredLogger) logger: StructuredLogger,
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

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async ensureIndex(indexUid: string, primaryKey: string): Promise<void> {
    try {
      await this.index(indexUid).fetchInfo();
      return;
    } catch (error: unknown) {
      if (!hasProviderCode(error, "index_not_found")) {
        throw safeMeilisearchError("read");
      }
    }

    await this.runMutation(() => this.requireClient().createIndex(indexUid, { primaryKey }));
  }

  async updateIndexSettings(
    indexUid: string,
    settings: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.runMutation(() => this.index(indexUid).updateSettings(settings));
  }

  async addDocuments(indexUid: string, documents: readonly object[]): Promise<void> {
    await this.runMutation(() => this.index(indexUid).addDocuments(documents));
  }

  async updateDocuments(indexUid: string, documents: readonly object[]): Promise<void> {
    await this.runMutation(() => this.index(indexUid).updateDocuments(documents));
  }

  async deleteDocuments(indexUid: string, documentIds: readonly string[]): Promise<void> {
    await this.runMutation(() => this.index(indexUid).deleteDocuments(documentIds));
  }

  async deleteDocumentsByFilter(indexUid: string, filter: string): Promise<void> {
    await this.runMutation(() => this.index(indexUid).deleteDocuments({ filter }));
  }

  async getDocumentsPage(
    indexUid: string,
    options: {
      readonly fields: readonly string[];
      readonly offset: number;
      readonly limit: number;
      readonly filter?: string;
    },
  ): Promise<MeilisearchDocumentsPage> {
    try {
      return await this.index(indexUid).getDocuments(options);
    } catch {
      throw safeMeilisearchError("read");
    }
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

  private index(indexUid: string): MeilisearchIndex {
    return this.requireClient().index(indexUid);
  }

  private async runMutation(operation: () => Promise<MeilisearchTaskReference>): Promise<void> {
    let task: MeilisearchTaskReference;
    try {
      task = await operation();
    } catch {
      throw safeMeilisearchError("mutation");
    }
    await this.waitForTask(task.taskUid);
  }

  private async waitForTask(taskUid: number): Promise<void> {
    const deadline = Date.now() + this.config.taskTimeoutMs;

    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw safeMeilisearchError("task_timeout");
      }

      let task: MeilisearchTask;
      try {
        task = await withTimeout(
          () => this.requireClient().tasks.getTask(taskUid),
          Math.max(1, remainingMs),
        );
      } catch {
        throw safeMeilisearchError(
          Date.now() >= deadline || remainingMs <= 1 ? "task_timeout" : "task_status",
        );
      }

      if (task.status === "succeeded") {
        return;
      }
      if (task.status === "failed" || task.status === "canceled" || task.status === "cancelled") {
        throw safeMeilisearchError("task_failed");
      }

      const delayMs = Math.min(this.config.taskPollIntervalMs, deadline - Date.now());
      if (delayMs <= 0) {
        throw safeMeilisearchError("task_timeout");
      }
      await wait(delayMs);
    }
  }
}

function hasProviderCode(error: unknown, code: string): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) return false;
    if ("code" in candidate && (candidate as { readonly code?: unknown }).code === code)
      return true;
    candidate =
      "cause" in candidate ? (candidate as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
}

function safeMeilisearchError(operation: string): Error {
  return new Error(`Meilisearch ${operation} failed`);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
