import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { StructuredLogger } from "./logging/structured-logger.service";
import { InMemoryRateLimitStore } from "./rate-limit/in-memory-rate-limit.store";
import { RateLimitGuard } from "./rate-limit/rate-limit.guard";
import { RateLimitService } from "./rate-limit/rate-limit.service";
import { RATE_LIMIT_STORE } from "./rate-limit/rate-limit.types";
import { RequestContextMiddleware } from "./request/request-context.middleware";
import { VerifiedHostsService } from "./verified-hosts.service";

@Global()
@Module({
  providers: [
    StructuredLogger,
    RequestContextMiddleware,
    // Part 73. Lives here, not in `DomainsModule`: `AuthService` needs it and
    // `DomainsModule` imports `AuthModule`, so the arrow would be circular.
    VerifiedHostsService,
    InMemoryRateLimitStore,
    RateLimitService,
    {
      provide: RATE_LIMIT_STORE,
      useExisting: InMemoryRateLimitStore,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
  exports: [
    RateLimitService,
    RequestContextMiddleware,
    StructuredLogger,
    VerifiedHostsService,
    RATE_LIMIT_STORE,
  ],
})
export class CommonModule {}
