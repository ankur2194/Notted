import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { AuthorizationAdaptersService } from "./authorization-adapters.service";
import { AuthorizationEntryService } from "./authorization-entry.service";
import { AuthorizationHttpGuard } from "./authorization-http.guard";
import { AuthorizationHttpInterceptor } from "./authorization-http.interceptor";
import { AuthorizationPolicyModule } from "./authorization-policy.module";
import { AuthorizationRepository } from "./authorization.repository";

@Module({
  imports: [AuthModule, AuthorizationPolicyModule],
  providers: [
    AuthorizationRepository,
    AuthorizationEntryService,
    AuthorizationAdaptersService,
    AuthorizationHttpGuard,
    AuthorizationHttpInterceptor,
  ],
  exports: [
    AuthorizationPolicyModule,
    AuthorizationEntryService,
    AuthorizationAdaptersService,
    AuthorizationHttpGuard,
    AuthorizationHttpInterceptor,
  ],
})
export class AuthorizationModule {}
