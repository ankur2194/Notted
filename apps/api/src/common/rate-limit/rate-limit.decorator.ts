import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_EXEMPT = Symbol("RATE_LIMIT_EXEMPT");

export const RateLimitExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_EXEMPT, true);
