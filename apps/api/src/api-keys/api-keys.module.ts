import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { ApiKeyAuthService } from "./api-key-auth.service";
import { ApiKeyRouteGuard } from "./api-key-route.guard";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";

@Module({
  // DatabaseModule, TenantContextModule, ConfigModule and CommonModule are all
  // @Global, so only the two non-global collaborators are imported here
  // (mirrors TagsModule).
  imports: [AuthModule, AuthorizationModule],
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    ApiKeyAuthService,
    // Application-wide: an API-key request must not reach a handler that has no
    // authorization spec, wherever in the router that handler lives.
    { provide: APP_GUARD, useClass: ApiKeyRouteGuard },
  ],
  exports: [ApiKeysService, ApiKeyAuthService],
})
export class ApiKeysModule {}
