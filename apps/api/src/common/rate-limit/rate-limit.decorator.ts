import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_EXEMPT = Symbol("RATE_LIMIT_EXEMPT");

export const RateLimitExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_EXEMPT, true);

/**
 * Selects a separate bucket for a route. `sensitive` uses the sensitive limit;
 * `public-ip` uses the unauthenticated limit and the trusted request IP even
 * if a session or API key is present (public bearer links are not actor-scoped).
 */
export const RATE_LIMIT_TIER = Symbol("RATE_LIMIT_TIER");

export type RateLimitTierName = "sensitive" | "public-ip";

export const RateLimitTier = (tier: RateLimitTierName): MethodDecorator =>
  SetMetadata(RATE_LIMIT_TIER, tier);
