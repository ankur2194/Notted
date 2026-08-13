import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { MEILISEARCH_CONFIG, type MeilisearchConfig } from "../../config/meilisearch.config";
import { DependencyState, retryBounded, withTimeout } from "../dependency-lifecycle";

import {
  MEILISEARCH_CLIENT,
  type MeilisearchClient,
  type MeilisearchDocumentsPage,
  type MeilisearchIndex,
  type MeilisearchSearchHit,
  type MeilisearchSearchOptions,
  type MeilisearchSearchResponse,
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

  /**
   * Run a Meilisearch search and return a provider-neutral
   * {@link MeilisearchSearchResponse}. Only the allow-listed fields on
   * {@link MeilisearchSearchHit} are surfaced; everything else the SDK returns
   * is dropped at this boundary so provider drift cannot leak into the
   * application layer. Provider errors are collapsed to a generic
   * `Meilisearch search failed` so request content is never echoed.
   */
  async search(
    indexUid: string,
    options: MeilisearchSearchOptions,
  ): Promise<MeilisearchSearchResponse> {
    try {
      const { query, ...providerOptions } = options;
      const raw = await this.index(indexUid).search(query, providerOptions);
      return parseSearchResponse(raw);
    } catch {
      throw safeMeilisearchError("search");
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

/**
 * Narrow the raw SDK search response to the allow-listed
 * {@link MeilisearchSearchResponse}. Unknown fields and unknown `_formatted`
 * fields are dropped. Malformed shapes are surfaced as a generic
 * `Meilisearch search failed` error so request content never echoes back.
 */
function parseSearchResponse(raw: unknown): MeilisearchSearchResponse {
  if (typeof raw !== "object" || raw === null) {
    throw safeMeilisearchError("search");
  }
  const root = raw as Record<string, unknown>;
  const hitsRaw = Array.isArray(root.hits) ? root.hits : [];
  const hits = hitsRaw.map(parseSearchHit);
  const estimatedTotalHits =
    typeof root.estimatedTotalHits === "number" && Number.isFinite(root.estimatedTotalHits)
      ? Math.max(0, Math.trunc(root.estimatedTotalHits))
      : 0;
  const offset =
    typeof root.offset === "number" && Number.isFinite(root.offset)
      ? Math.max(0, Math.trunc(root.offset))
      : 0;
  const limit =
    typeof root.limit === "number" && Number.isFinite(root.limit)
      ? Math.max(0, Math.trunc(root.limit))
      : 0;
  const processingTimeMs =
    typeof root.processingTimeMs === "number" && Number.isFinite(root.processingTimeMs)
      ? Math.max(0, Math.trunc(root.processingTimeMs))
      : 0;
  return Object.freeze({
    hits,
    estimatedTotalHits,
    offset,
    limit,
    processingTimeMs,
  });
}

function parseSearchHit(raw: unknown): MeilisearchSearchHit {
  if (typeof raw !== "object" || raw === null) {
    throw safeMeilisearchError("search");
  }
  const hit = raw as Record<string, unknown>;
  if (typeof hit.id !== "string") {
    throw safeMeilisearchError("search");
  }
  const pickString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const pickStringArray = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? Object.freeze(value as readonly string[])
      : undefined;
  const formattedRaw = hit._formatted;
  const formattedRecord =
    typeof formattedRaw === "object" && formattedRaw !== null
      ? (formattedRaw as Record<string, unknown>)
      : null;
  const formattedTags = formattedRecord?.tags;
  const formatted =
    formattedRecord !== null
      ? Object.freeze({
          ...(typeof formattedRecord.title === "string" ? { title: formattedRecord.title } : {}),
          ...(typeof formattedRecord.content === "string"
            ? { content: formattedRecord.content }
            : {}),
          ...(Array.isArray(formattedTags) &&
          formattedTags.every((entry: unknown) => typeof entry === "string")
            ? {
                tags: Object.freeze(formattedTags as readonly string[]),
              }
            : {}),
        })
      : undefined;
  return Object.freeze({
    id: hit.id,
    ...(pickString(hit.title) === undefined ? {} : { title: pickString(hit.title) }),
    ...(pickString(hit.content) === undefined ? {} : { content: pickString(hit.content) }),
    ...(pickStringArray(hit.tags) === undefined ? {} : { tags: pickStringArray(hit.tags) }),
    ...(formatted === undefined ? {} : { _formatted: formatted }),
    ...(typeof hit._rankingScore === "number" && Number.isFinite(hit._rankingScore)
      ? { _rankingScore: hit._rankingScore }
      : {}),
  });
}
