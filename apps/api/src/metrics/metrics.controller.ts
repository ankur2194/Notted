// Part 78 — the Prometheus exposition endpoint.
//
// MOUNTED AT `/metrics`, NOT `/api/v1/metrics`. It is an operational route in
// the same class as `/health/live` and `/health/ready`: an operator points a
// scraper at it, no first-party client calls it, and versioning it would imply
// a compatibility promise to a consumer that reads the exposition format
// instead of a JSON contract. `main.ts` adds it to the `setGlobalPrefix`
// exclusion list for exactly that reason.
//
// AUTHENTICATION IS A SHARED BEARER TOKEN, AND THAT IS A DELIBERATE DOWNGRADE
// FROM EVERY OTHER SURFACE IN THIS API. Three alternatives were considered:
//
//  * `PlatformOperatorService.requireOperator`, which guards Bull Board — it
//    requires a **Better Auth cookie session**, and a Prometheus scraper has
//    no browser, no cookie jar and no way to sign in. Unusable here.
//  * An API key from Part 65 — those are workspace-scoped by construction, and
//    a platform-wide metrics endpoint has no workspace to scope to.
//  * Network-only exposure (bind to a second port, or trust the proxy) — real
//    defence in depth, but it is a deployment property this repository cannot
//    enforce, so it is documented as an ADDITIONAL control in the runbook
//    rather than accepted as the only one.
//
// A weaker auth boundary is precisely why `metrics.registry.ts` forbids tenant
// identifiers as labels: whoever holds this token must learn nothing about who
// the tenants are, only how the machine is behaving.
//
// A WRONG OR MISSING TOKEN ANSWERS 404, never 401. The endpoint's existence is
// not something an unauthenticated caller gets to confirm, and — combined with
// the default-off configuration — there is no state in which a deployment ships
// this open. `timingSafeEqual` over SHA-256 digests keeps the comparison
// constant-time AND length-independent: comparing the raw strings would leak
// the token's length through the buffer-length check, and `===` would leak a
// matching prefix through its early return.

import { createHash, timingSafeEqual } from "node:crypto";

import { Controller, Get, Headers, Inject, NotFoundException, Res } from "@nestjs/common";

import { RateLimitExempt } from "../common/rate-limit/rate-limit.decorator";
import { APP_CONFIG, type AppConfig } from "../config/app.config";

import { register } from "./metrics.registry";

import type { Response } from "express";

const BEARER = /^Bearer (.+)$/u;

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * `@RateLimitExempt` because `RateLimitGuard` is a global `APP_GUARD`: without
   * it a scraper would consume the unauthenticated per-IP budget and eventually
   * be throttled into gaps in the very series used to diagnose the throttling.
   * The token is the access control; the rate limit was never it.
   */
  @Get()
  @RateLimitExempt()
  async metrics(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    if (!this.authorized(authorization)) {
      throw new NotFoundException();
    }

    response.setHeader("Content-Type", register.contentType);
    // A scrape is a point-in-time reading; a cached one is a lie with a
    // timestamp on it.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    return register.metrics();
  }

  private authorized(authorization: string | undefined): boolean {
    const expected = this.config.metricsToken;
    if (expected === null || authorization === undefined) return false;
    const presented = BEARER.exec(authorization)?.[1];
    if (presented === undefined) return false;
    return timingSafeEqual(digest(expected), digest(presented));
  }
}
