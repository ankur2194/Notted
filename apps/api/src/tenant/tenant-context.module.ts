// Part 19: NestJS module wiring for the tenant-context infrastructure.
//
// A `@Global()` module so Part 24+ guards/interceptors/policies/repositories/
// jobs can inject {@link TenantContextService} without per-module imports.
// Mirrors the {@link DatabaseModule} and {@link ConfigModule} pattern: a
// single global module owns the primitive, every consumer injects the service.
//
// Until Part 21+ wires the auth/policy layer, this module has no runtime
// callers — it is wired into the app so the primitive is available as soon as
// Phase 4 services start consuming it.

import { Global, Module } from "@nestjs/common";

import { TenantContextService } from "./tenant-context.service";

@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantContextModule {}
