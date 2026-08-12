import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AuthService } from "../auth/auth.service";
import { ApiHttpException } from "../common/errors/api-http.exception";

import {
  BULL_BOARD_PATH,
  bullBoardRequestPolicy,
  hasSafeBullBoardQuery,
} from "./bull-board-policy";
import { safeJobJson } from "./redacted-bull-mq.adapter";

import type { AuthConfig } from "../config/auth.config";
import type { RetentionConfig } from "../config/retention.config";
import type { Job } from "bullmq";
import type { Request } from "express";

describe("Bull Board security contract", () => {
  it("keeps the literal route outside /api/v1", () => {
    expect(BULL_BOARD_PATH).toBe("/admin/queues");
    const main = readFileSync(resolve(__dirname, "../main.ts"), "utf8");
    expect(main).toContain("express.use(\n    BULL_BOARD_PATH");
    expect(main.indexOf("express.use(\n    BULL_BOARD_PATH")).toBeLessThan(
      main.indexOf('app.setGlobalPrefix("api/v1"'),
    );
  });

  it("allows reads but only durable individual failed-job retry mutations", () => {
    expect(bullBoardRequestPolicy("GET", "/api/queues")).toEqual({ kind: "read" });
    expect(bullBoardRequestPolicy("PUT", "/api/queues/notted-default/job_1/retry/failed")).toEqual({
      kind: "mutation",
      audit: { action: "queue.retry", queueName: "notted-default", jobId: "job_1" },
    });
    expect(bullBoardRequestPolicy("PUT", "/api/queues/notted-dead-letter/clean/failed")).toBeNull();
    expect(bullBoardRequestPolicy("PUT", "/api/queues/notted-default/clean/failed")).toBeNull();
    expect(bullBoardRequestPolicy("PUT", "/api/queues/notted-default/retry/failed")).toBeNull();
    expect(bullBoardRequestPolicy("POST", "/api/queues/notted-default/add")).toBeNull();
    expect(
      bullBoardRequestPolicy("PATCH", "/api/queues/notted-default/job_1/update-data"),
    ).toBeNull();
    expect(bullBoardRequestPolicy("GET", "/api/redis/stats")).toBeNull();
  });

  it("installs a self-host-only board CSP without weakening global Helmet", () => {
    const main = readFileSync(resolve(__dirname, "../main.ts"), "utf8");
    expect(main).toContain("helmet.contentSecurityPolicy");
    expect(main).toContain("scriptSrc: [\"'self'\"]");
    expect(main).toContain("connectSrc: [\"'self'\"]");
    expect(main).toContain("frameAncestors: [\"'none'\"]");
  });

  it("bounds queue-list query work and denies unknown query input", () => {
    expect(
      hasSafeBullBoardQuery({
        activeQueue: "notted-ai",
        jobsPerPage: "100",
        page: "1",
        status: "failed",
      }),
    ).toBe(true);
    expect(hasSafeBullBoardQuery({ jobsPerPage: "100000" })).toBe(false);
    expect(hasSafeBullBoardQuery({ payload: "please-return-it" })).toBe(false);
  });

  it("fails unsafe requests closed when Origin is absent or untrusted", () => {
    const auth = new AuthService(
      null,
      { trustedOrigins: ["https://app.example.test"] } as unknown as AuthConfig,
      {} as RetentionConfig,
    );
    const absent = { header: () => undefined } as unknown as Request;
    const invalid = { header: () => "https://evil.example" } as unknown as Request;
    expect(() => auth.assertTrustedMutationOrigin(absent)).toThrow(ApiHttpException);
    expect(() => auth.assertTrustedMutationOrigin(invalid)).toThrow(ApiHttpException);
  });

  it("replaces payload, result, progress, name, provider detail, and stacks", () => {
    const raw = {
      id: "job_1",
      name: "send-private-email",
      data: { note: "secret" },
      returnvalue: { providerResponse: "secret" },
      progress: { email: "private@example.test" },
      attemptsMade: 2,
      finishedOn: 3,
      processedOn: 2,
      processedBy: "provider-worker-host",
      delay: 0,
      timestamp: 1,
      failedReason: "provider account and stack detail",
      stacktrace: ["secret stack"],
      opts: { attempts: 3, delay: 0, priority: 1 },
    } as ReturnType<Job["toJSON"]>;
    expect(safeJobJson(raw)).toMatchObject({
      name: "redacted-job",
      data: { redacted: true },
      returnvalue: { redacted: true },
      progress: 0,
      processedBy: null,
      failedReason: "redacted-error",
      stacktrace: null,
    });
  });
});
