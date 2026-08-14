import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { REDIS_CONFIG, type RedisConfig } from "../../config/redis.config";
import { DependencyState, retryBounded, withTimeout } from "../dependency-lifecycle";

import { REDIS_CLIENT } from "./redis.tokens";

import type { ReadinessCheckResult, ReadinessIndicator } from "../../health/readiness-indicator";
import type Redis from "ioredis";

@Injectable()
export class RedisService implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown {
  readonly name = "redis";
  private readonly state: DependencyState;
  private shuttingDown = false;

  constructor(
    @Inject(REDIS_CONFIG) private readonly config: RedisConfig,
    @Inject(REDIS_CLIENT) private readonly client: Redis | null,
    logger: StructuredLogger,
  ) {
    this.state = new DependencyState(this.name, config.enabled, logger);
    this.client?.on("ready", () => this.state.transition("up"));
    this.client?.on("error", () => this.state.transition("down"));
    this.client?.on("close", () => {
      if (!this.shuttingDown) {
        this.state.transition("down");
      }
    });
    this.client?.on("end", () => {
      if (!this.shuttingDown) {
        this.state.transition("down");
      }
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.client === null) {
      return;
    }
    try {
      await retryBounded(
        () => this.ping(),
        this.config.startupRetryAttempts,
        this.config.retryDelayMs,
      );
      this.state.transition("up");
    } catch {
      this.state.transition("down");
    }
  }

  async get(key: string): Promise<string | null> {
    return this.requireClient().get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const client = this.requireClient();
    if (ttlMs === undefined) {
      await client.set(key, value);
    } else {
      await client.set(key, value, "PX", ttlMs);
    }
  }

  async delete(key: string): Promise<void> {
    await this.requireClient().del(key);
  }

  async getAndDelete(key: string): Promise<string | null> {
    return this.requireClient().getdel(key);
  }

  /** Atomic fixed-window increment; ttlMs is applied only when the key is created. */
  async incrementWithTtl(key: string, ttlMs: number): Promise<number> {
    const result = await this.requireClient().eval(
      "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return value",
      1,
      key,
      String(ttlMs),
    );
    if (typeof result !== "number") {
      throw new Error("Redis increment returned an invalid result");
    }
    return result;
  }

  /** Atomically acquires one member of a bounded expiring distributed set. */
  async acquireBoundedLease(
    key: string,
    leaseId: string,
    limit: number,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.requireClient().eval(
      "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); if redis.call('ZSCORE', KEYS[1], ARGV[2]) then redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2]); redis.call('PEXPIRE', KEYS[1], ARGV[4]); return 1; end; if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0; end; redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2]); redis.call('PEXPIRE', KEYS[1], ARGV[4]); return 1",
      1,
      key,
      String(Date.now()),
      leaseId,
      String(Date.now() + ttlMs),
      String(ttlMs),
      String(limit),
    );
    return result === 1;
  }

  /** Releases a distributed lease only by its opaque member value. */
  async releaseLease(key: string, leaseId: string): Promise<void> {
    await this.requireClient().zrem(key, leaseId);
  }

  async publish(channel: string, payload: string): Promise<number> {
    return this.requireClient().publish(channel, payload);
  }

  async check(): Promise<ReadinessCheckResult> {
    if (this.client === null) {
      return this.state.result();
    }
    try {
      await this.ping();
      this.state.transition("up");
      return this.state.result();
    } catch {
      this.state.transition("down");
      return this.state.result("Redis probe failed");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.state.transition("down");
    if (this.client === null) {
      return;
    }
    try {
      await withTimeout(
        () => this.client!.quit().then(() => undefined),
        this.config.commandTimeoutMs,
      );
    } catch {
      this.client.disconnect(false);
    }
  }

  private async ping(): Promise<void> {
    const client = this.requireClient();
    if (client.status === "wait" || client.status === "end") {
      await withTimeout(() => client.connect(), this.config.connectTimeoutMs);
    }
    const response = await withTimeout(() => client.ping(), this.config.readinessTimeoutMs);
    if (response !== "PONG") {
      throw new Error("unexpected Redis ping response");
    }
  }

  private requireClient(): Redis {
    if (this.client === null) {
      throw new Error("Redis is disabled");
    }
    return this.client;
  }
}
