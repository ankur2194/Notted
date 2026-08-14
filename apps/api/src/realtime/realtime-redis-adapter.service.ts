import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";

import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { REDIS_CONFIG, type RedisConfig } from "../config/redis.config";
import { withTimeout } from "../infrastructure/dependency-lifecycle";

import type { ReadinessCheckResult, ReadinessIndicator } from "../health/readiness-indicator";

function client(config: RedisConfig): Redis {
  return new Redis(config.url, {
    lazyConnect: true,
    connectTimeout: config.connectTimeoutMs,
    commandTimeout: config.commandTimeoutMs,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(config.retryDelayMs * attempt, config.retryMaxDelayMs),
  });
}

@Injectable()
export class RealtimeRedisAdapterService
  implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown
{
  readonly name = "realtime";
  private readonly publisher: Redis | null;
  private readonly subscriber: Redis | null;
  private ready = false;
  private initialization?: Promise<void>;

  constructor(
    @Inject(REDIS_CONFIG) private readonly config: RedisConfig,
    @Inject(FEATURES_CONFIG) private readonly features: FeaturesConfig,
  ) {
    this.publisher = features.realtimeEnabled ? client(config) : null;
    this.subscriber = features.realtimeEnabled ? client(config) : null;
    for (const connection of [this.publisher, this.subscriber]) {
      connection?.on("error", () => {
        this.ready = false;
      });
      connection?.on("close", () => {
        this.ready = false;
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  /**
   * Socket.io creates its server before Nest module-init hooks run. Bootstrap
   * therefore awaits this idempotent prerequisite before installing the
   * Socket.io adapter; otherwise an offline-queue-disabled Redis client cannot
   * subscribe while still in its lazy `wait` state.
   */
  initialize(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    this.initialization = this.connectClients();
    return this.initialization;
  }

  private async connectClients(): Promise<void> {
    if (this.publisher === null || this.subscriber === null) return;
    try {
      await Promise.all([
        withTimeout(() => this.publisher!.connect(), this.config.connectTimeoutMs),
        withTimeout(() => this.subscriber!.connect(), this.config.connectTimeoutMs),
      ]);
      this.ready = true;
    } catch {
      this.ready = false;
      throw new Error("Realtime Redis adapter initialization failed");
    }
  }

  adapter(): ReturnType<typeof createAdapter> | null {
    if (!this.features.realtimeEnabled) return null;
    if (this.publisher === null || this.subscriber === null) {
      throw new Error("Realtime Redis adapter is unavailable");
    }
    return createAdapter(this.publisher, this.subscriber);
  }

  isReady(): boolean {
    return (
      !this.features.realtimeEnabled ||
      (this.ready && this.publisher?.status === "ready" && this.subscriber?.status === "ready")
    );
  }

  async check(): Promise<ReadinessCheckResult> {
    if (!this.features.realtimeEnabled) return { name: this.name, status: "disabled" };
    try {
      if (this.publisher === null || this.subscriber === null) throw new Error("missing clients");
      // The adapter puts its subscriber connection into Redis subscriber mode.
      // Its PING response is shaped differently from a regular command client,
      // so probe the publisher and use both clients' connection state here.
      const reply = await this.publisher.ping();
      this.ready =
        reply === "PONG" && this.publisher.status === "ready" && this.subscriber.status === "ready";
    } catch {
      this.ready = false;
    }
    return {
      name: this.name,
      status: this.ready ? "up" : "down",
      ...(this.ready ? {} : { message: "Realtime adapter unavailable" }),
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.ready = false;
    await Promise.allSettled([this.close(this.publisher), this.close(this.subscriber)]);
  }

  private async close(connection: Redis | null): Promise<void> {
    if (connection === null || connection.status === "end") return;
    try {
      await withTimeout(
        () => connection.quit().then(() => undefined),
        this.config.commandTimeoutMs,
      );
    } catch {
      connection.disconnect(false);
    }
  }
}
