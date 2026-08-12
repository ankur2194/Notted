import { describe, expect, it } from "vitest";

import { PHYSICAL_QUEUE_NAMES } from "../queue";

import { parseQueueConfig } from "./queue.config";

describe("queue configuration", () => {
  it("uses bounded defaults and fixes export concurrency at two", () => {
    const config = parseQueueConfig({});

    expect(config.attempts).toBe(3);
    expect(config.backoff).toEqual({ baseMs: 1_000, maximumMs: 60_000, jitter: 0.2 });
    expect(config.workers[PHYSICAL_QUEUE_NAMES.export].concurrency).toBe(2);
    expect(config.aiProviderLimits.openAi).toEqual({ maximum: 5, durationMs: 1_000 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    [{ QUEUE_ATTEMPTS: "6" }, "QUEUE_ATTEMPTS"],
    [{ QUEUE_EXPORT_CONCURRENCY: "3" }, "QUEUE_EXPORT_CONCURRENCY"],
    [
      { QUEUE_BACKOFF_BASE_MS: "5000", QUEUE_BACKOFF_MAX_MS: "1000" },
      "must be greater than or equal",
    ],
    [
      { QUEUE_DISPATCH_INTERVAL_MS: "10000", QUEUE_DISPATCH_STALE_CLAIM_MS: "5000" },
      "must be greater than",
    ],
    [{ QUEUE_AI_OPENAI_RATE_MAX: "0" }, "QUEUE_AI_OPENAI_RATE_MAX"],
  ])("rejects unsafe values", (environment, message) => {
    expect(() => parseQueueConfig(environment)).toThrowError(message);
  });
});
