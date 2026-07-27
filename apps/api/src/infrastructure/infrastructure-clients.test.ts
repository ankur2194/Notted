import { describe, expect, it, vi } from "vitest";

import { parseMeilisearchConfig } from "../config/meilisearch.config";
import { parseMinioConfig } from "../config/minio.config";
import { parseRedisConfig } from "../config/redis.config";
import { parseSmtpConfig } from "../config/smtp.config";

import { DependencyState, retryBounded, withTimeout } from "./dependency-lifecycle";
import { MeilisearchService } from "./meilisearch/meilisearch.service";
import { MinioService } from "./minio/minio.service";
import { RedisService } from "./redis/redis.service";
import { SmtpService } from "./smtp/smtp.service";

import type { MeilisearchClient } from "./meilisearch/meilisearch.tokens";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type Redis from "ioredis";
import type { Client } from "minio";
import type { Agent } from "node:http";
import type { Transporter } from "nodemailer";

function createLogger(): {
  readonly logger: StructuredLogger;
  readonly info: ReturnType<typeof vi.fn>;
  readonly failure: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const failure = vi.fn();
  return {
    logger: { info, failure } as unknown as StructuredLogger,
    info,
    failure,
  };
}

describe("dependency lifecycle", () => {
  it("retries only to the configured bound", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue("ok");

    await expect(retryBounded(operation, 3, 1)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("times out without exposing the dependency error", async () => {
    await expect(withTimeout(() => new Promise<never>(() => undefined), 5)).rejects.toThrow(
      "dependency operation timed out",
    );
  });

  it("coalesces state logs and emits only safe transition metadata", () => {
    const { logger, info, failure } = createLogger();
    const state = new DependencyState("redis", true, logger);

    state.transition("down");
    state.transition("down");
    state.transition("up");
    state.transition("up");

    expect(failure).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(
      { dependency: "redis", status: "down", durationMs: 0 },
      "Dependency readiness changed",
    );
  });
});

describe("RedisService", () => {
  it("reports disabled without constructing or probing a client", async () => {
    const { logger } = createLogger();
    const service = new RedisService(
      parseRedisConfig({ FEATURE_REDIS_ENABLED: "false" }),
      null,
      logger,
    );

    await expect(service.check()).resolves.toEqual({ name: "redis", status: "disabled" });
  });

  it("reports failure, recovers on a later probe, and closes gracefully", async () => {
    const listeners = new Map<string, () => void>();
    const ping = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("redis://user:secret@cache"))
      .mockResolvedValue("PONG");
    const quit = vi.fn().mockResolvedValue("OK");
    const client = {
      status: "ready",
      on: vi.fn((event: string, callback: () => void) => {
        listeners.set(event, callback);
        return client;
      }),
      ping,
      quit,
      disconnect: vi.fn(),
    } as unknown as Redis;
    const { logger, failure, info } = createLogger();
    const service = new RedisService(
      parseRedisConfig({ NODE_ENV: "test", REDIS_COMMAND_TIMEOUT_MS: "100" }),
      client,
      logger,
    );

    await service.onModuleInit();
    await expect(service.check()).resolves.toEqual({ name: "redis", status: "up" });
    await service.onApplicationShutdown();

    expect(failure).toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { dependency: "redis", status: "up", durationMs: 0 },
      "Dependency readiness changed",
    );
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("reconnects after Redis reaches its terminal end state", async () => {
    const client = {
      status: "end",
      on: vi.fn().mockReturnThis(),
      connect: vi.fn(async () => {
        client.status = "ready";
      }),
      ping: vi.fn().mockResolvedValue("PONG"),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
    } as unknown as Redis;
    const { logger } = createLogger();
    const service = new RedisService(
      parseRedisConfig({ NODE_ENV: "test", REDIS_CONNECT_TIMEOUT_MS: "100" }),
      client,
      logger,
    );

    await expect(service.check()).resolves.toEqual({ name: "redis", status: "up" });
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

describe("MinioService", () => {
  it("requires both private buckets and destroys its agent on shutdown", async () => {
    const bucketExists = vi
      .fn<(bucket: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const client = { bucketExists } as unknown as Client;
    const destroy = vi.fn();
    const agent = { destroy } as unknown as Agent;
    const { logger } = createLogger();
    const service = new MinioService(
      parseMinioConfig({ NODE_ENV: "test", MINIO_READINESS_TIMEOUT_MS: "100" }),
      client,
      agent,
      logger,
    );

    await service.onModuleInit();
    await expect(service.check()).resolves.toEqual({ name: "minio", status: "up" });
    service.onApplicationShutdown();

    expect(bucketExists).toHaveBeenCalledWith("notted-attachments");
    expect(bucketExists).toHaveBeenCalledWith("notted-exports");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("MeilisearchService", () => {
  it("is recovery-compatible across readiness probes", async () => {
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error("api-key=secret"))
      .mockResolvedValue({ status: "available" });
    const { logger } = createLogger();
    const service = new MeilisearchService(
      parseMeilisearchConfig({ NODE_ENV: "test", MEILISEARCH_READINESS_TIMEOUT_MS: "100" }),
      { health } as unknown as MeilisearchClient,
      logger,
    );

    await service.onModuleInit();
    await expect(service.check()).resolves.toEqual({ name: "meilisearch", status: "up" });
    service.onApplicationShutdown();
  });
});

describe("SmtpService", () => {
  it("verifies, sends through the narrow contract, and closes gracefully", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const sendMail = vi.fn().mockResolvedValue({ messageId: "message-1" });
    const close = vi.fn();
    const transport = { verify, sendMail, close } as unknown as Transporter;
    const { logger } = createLogger();
    const service = new SmtpService(
      parseSmtpConfig({ NODE_ENV: "test", EMAIL_SMTP_READINESS_TIMEOUT_MS: "100" }),
      transport,
      logger,
    );

    await service.onModuleInit();
    await expect(
      service.send({ to: "person@example.com", subject: "Subject", text: "Body" }),
    ).resolves.toBe("message-1");
    await expect(service.check()).resolves.toEqual({ name: "smtp", status: "up" });
    service.onApplicationShutdown();

    expect(sendMail).toHaveBeenCalledWith({
      from: "noreply@notted.local",
      to: "person@example.com",
      subject: "Subject",
      text: "Body",
      html: undefined,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
