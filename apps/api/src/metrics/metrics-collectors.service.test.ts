import { describe, expect, it, vi } from "vitest";

import { MetricsCollectorsService } from "./metrics-collectors.service";
import {
  databasePoolConnections,
  databasePoolMax,
  dependencyUp,
  jobOutboxRows,
  queueJobs,
  register,
  storageBytes,
} from "./metrics.registry";

type SampleLabels = Partial<Record<string, string | number>>;

/**
 * Structural rather than `Gauge<T>`: the gauges under test have different label
 * type parameters, and only `get()` is needed here.
 */
interface SampledGauge {
  get(): Promise<{
    readonly values: readonly { readonly labels: SampleLabels; readonly value: number }[];
  }>;
}

async function sampleOf(
  gauge: SampledGauge,
  match: (labels: SampleLabels) => boolean,
): Promise<number | undefined> {
  const metric = await gauge.get();
  return metric.values.find((value) => match(value.labels))?.value;
}

function serviceWith(overrides: {
  readonly readiness?: unknown;
  readonly queues?: unknown;
  readonly database?: unknown;
}): MetricsCollectorsService {
  return new MetricsCollectorsService(
    (overrides.readiness ?? {
      getReadiness: vi.fn().mockResolvedValue({ status: "ready", checks: [] }),
    }) as never,
    (overrides.queues ?? { jobCounts: vi.fn().mockResolvedValue([]) }) as never,
    (overrides.database ?? {
      db: {},
      poolStats: () => ({ total: 3, idle: 2, waiting: 1 }),
    }) as never,
    { poolMaxConnections: 10 } as never,
  );
}

describe("MetricsCollectorsService", () => {
  it("mirrors readiness onto the dependency gauge, counting disabled as up", async () => {
    serviceWith({
      readiness: {
        getReadiness: vi.fn().mockResolvedValue({
          status: "not_ready",
          checks: [
            { name: "database", status: "up" },
            { name: "meilisearch", status: "disabled" },
            { name: "redis", status: "down" },
          ],
        }),
      },
    }).onModuleInit();

    await dependencyUp.get();

    expect(await sampleOf(dependencyUp, (l) => l.dependency === "database")).toBe(1);
    // A dependency switched off is a configuration choice, not an outage; the
    // alert rule is `== 0`, and paging for a deliberate setting is the noise
    // this part is meant to avoid.
    expect(await sampleOf(dependencyUp, (l) => l.dependency === "meilisearch")).toBe(1);
    expect(await sampleOf(dependencyUp, (l) => l.dependency === "redis")).toBe(0);
  });

  it("publishes the configured pool ceiling and live pool counts", async () => {
    serviceWith({}).onModuleInit();
    await databasePoolConnections.get();

    expect(await sampleOf(databasePoolMax, () => true)).toBe(10);
    expect(await sampleOf(databasePoolConnections, (l) => l.state === "waiting")).toBe(1);
    expect(await sampleOf(databasePoolConnections, (l) => l.state === "total")).toBe(3);
  });

  it("keeps every gauge's previous value when its source fails, and never fails the scrape", async () => {
    // THE LOAD-BEARING TEST OF THIS PART. `Registry.metrics()` awaits
    // `Promise.all` over every metric, so one rejecting collector would turn the
    // whole scrape into a 500 — losing HTTP rate, error rate and event-loop lag
    // at the exact moment a dependency is down, which is when they matter most.
    queueJobs.set({ queue: "notted-export", state: "waiting" }, 12);
    jobOutboxRows.set({ status: "pending" }, 41);
    storageBytes.set({ status: "ready" }, 99);

    serviceWith({
      readiness: { getReadiness: vi.fn().mockRejectedValue(new Error("probe failed")) },
      queues: { jobCounts: vi.fn().mockRejectedValue(new Error("redis is down")) },
      // `db` has no `select`, so both database collectors throw a TypeError —
      // the unanticipated failure shape, not a rehearsed rejection.
      database: { db: {}, poolStats: () => ({ total: 0, idle: 0, waiting: 0 }) },
    }).onModuleInit();

    const body = await register.metrics();

    expect(body).toContain("notted_http_request_duration_seconds");
    expect(
      await sampleOf(queueJobs, (l) => l.queue === "notted-export" && l.state === "waiting"),
    ).toBe(12);
    expect(await sampleOf(jobOutboxRows, (l) => l.status === "pending")).toBe(41);
    expect(await sampleOf(storageBytes, (l) => l.status === "ready")).toBe(99);
  });
});
