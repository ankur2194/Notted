import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { DomainResolveController } from "./domain-resolve.controller";
import { DOMAIN_DNS_RESOLVER, defaultDomainDnsResolver } from "./domain-verifier";
import { DomainsController } from "./domains.controller";
import { DomainsService } from "./domains.service";
import { TrustedHostMiddleware } from "./trusted-host.middleware";

/**
 * Part 73 — custom domains.
 *
 * `DatabaseModule`, `TenantContextModule` and `CommonModule` (which provides
 * `VerifiedHostsService`) are `@Global()`, so only the two authorization modules
 * are named. The arrow points one way: `AuthModule` and `AuthorizationModule`
 * do not import this module, and only `AppModule` does.
 *
 * `TrustedHostMiddleware` is provided and exported here but is NOT wired through
 * `configure()`: `main.ts` resolves it and installs it with `app.use` ahead of
 * the Nest pipeline, because it must run before CORS and before the Better Auth
 * handler, and neither of those is a Nest route.
 */
@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [DomainsController, DomainResolveController],
  providers: [
    DomainsService,
    TrustedHostMiddleware,
    { provide: DOMAIN_DNS_RESOLVER, useValue: defaultDomainDnsResolver },
  ],
  exports: [DomainsService, TrustedHostMiddleware],
})
export class DomainsModule {}
