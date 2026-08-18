import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_EXEMPT = Symbol("RATE_LIMIT_EXEMPT");

export const RateLimitExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_EXEMPT, true);

/**
 * Opts a route into the sensitive tier (`RATE_LIMIT_SENSITIVE_PER_MINUTE`).
 * Read by `RateLimitGuard`; the tier keeps its own bucket so a sensitive route
 * can never drain the caller's general allowance.
 */
export const RATE_LIMIT_TIER = Symbol("RATE_LIMIT_TIER");

export const RateLimitTier = (tier: "sensitive"): MethodDecorator =>
  SetMetadata(RATE_LIMIT_TIER, tier);
