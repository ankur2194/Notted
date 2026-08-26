import { NotFoundException } from "@nestjs/common";
import { Gauge } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";

import { MetricsController } from "./metrics.controller";
import { register, setCollect } from "./metrics.registry";

import type { AppConfig } from "../config/app.config";
import type { Response } from "express";

const TOKEN = "0123456789abcdef0123456789abcdef";

function responseDouble(): { readonly response: Response; readonly headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
  } as unknown as Response;
  return { response, headers };
}

const controllerWith = (metricsToken: string | null): MetricsController =>
  new MetricsController({ metricsToken } as AppConfig);

describe("MetricsController", () => {
  afterEach(() => {
    register.removeSingleMetric("notted_test_collector_probe");
  });

  it("answers 404 when METRICS_TOKEN is unset, so the endpoint is not discoverable", async () => {
    const { response } = responseDouble();
    await expect(controllerWith(null).metrics(`Bearer ${TOKEN}`, response)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("answers 404 for a missing, malformed, or wrong token", async () => {
    const controller = controllerWith(TOKEN);
    for (const header of [
      undefined,
      "",
      TOKEN,
      `Basic ${TOKEN}`,
      "Bearer ",
      `Bearer ${TOKEN}x`,
      // A correct prefix must not be distinguishable from a wrong first byte.
      `Bearer ${TOKEN.slice(0, 31)}`,
    ]) {
      const { response } = responseDouble();
      await expect(controller.metrics(header, response)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it("serves the exposition format with the correct token and no-store headers", async () => {
    const { response, headers } = responseDouble();

    const body = await controllerWith(TOKEN).metrics(`Bearer ${TOKEN}`, response);

    expect(headers.get("Content-Type")).toBe(register.contentType);
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(body).toContain("notted_http_request_duration_seconds");
    expect(body).toContain("notted_process_cpu_user_seconds_total");
  });

  it("never exposes an identifier or a credential", async () => {
    const { response } = responseDouble();

    const body = await controllerWith(TOKEN).metrics(`Bearer ${TOKEN}`, response);

    // The label allow-list is the control; this is the evidence for it. A UUID
    // anywhere in the body means a workspace, user, note or request id became a
    // label, which is both a cardinality explosion and tenant disclosure on the
    // surface with the weakest authentication.
    expect(body).not.toMatch(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/iu);
    expect(body).not.toMatch(/secret|password|redis:\/\/|postgres:\/\//iu);
    expect(body).not.toContain(TOKEN);
  });

  it("still serves every other metric when one collector rejects", async () => {
    // THE MOST IMPORTANT ASSERTION IN THIS PART. `Registry.metrics()` awaits
    // `Promise.all` over every metric's `get()`, so an unguarded collector that
    // throws turns the whole scrape into a 500 — and Prometheus records nothing
    // at all, for any metric, at the exact moment a dependency is failing.
    const probe = new Gauge({
      name: "notted_test_collector_probe",
      help: "Test probe.",
      registers: [register],
    });
    setCollect(probe, () => Promise.reject(new Error("dependency is down")));

    const { response } = responseDouble();
    await expect(controllerWith(TOKEN).metrics(`Bearer ${TOKEN}`, response)).rejects.toThrow();

    // Guarded exactly as `MetricsCollectorsService.safely` guards every real
    // collector: the scrape survives and the gauge keeps its previous value.
    probe.set(7);
    setCollect(probe, async () => {
      try {
        await Promise.reject(new Error("dependency is still down"));
      } catch {
        // Keep the previous value.
      }
    });

    const { response: second } = responseDouble();
    const body = await controllerWith(TOKEN).metrics(`Bearer ${TOKEN}`, second);
    expect(body).toContain("notted_test_collector_probe 7");
    expect(body).toContain("notted_http_request_duration_seconds");
  });
});
