import { Injectable } from "@nestjs/common";

import { RedisService } from "../infrastructure/redis/redis.service";

import type { SecondaryStorage } from "better-auth";

const KEY_PREFIX = "notted:better-auth:";
const MILLISECONDS_PER_SECOND = 1_000;

function secondsToMilliseconds(seconds: number): number {
  const milliseconds = seconds * MILLISECONDS_PER_SECOND;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("Better Auth Redis TTL must be a positive safe integer");
  }
  return milliseconds;
}

@Injectable()
export class BetterAuthRedisStorage implements SecondaryStorage {
  constructor(private readonly redis: RedisService) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(this.key(key));
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return this.redis.set(
      this.key(key),
      value,
      ttlSeconds === undefined ? undefined : secondsToMilliseconds(ttlSeconds),
    );
  }

  delete(key: string): Promise<void> {
    return this.redis.delete(this.key(key));
  }

  getAndDelete(key: string): Promise<string | null> {
    return this.redis.getAndDelete(this.key(key));
  }

  increment(key: string, ttlSeconds: number): Promise<number> {
    return this.redis.incrementWithTtl(this.key(key), secondsToMilliseconds(ttlSeconds));
  }

  private key(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }
}
