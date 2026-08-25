// Part 71 — the read-only audit REST surface.

import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { AuditLogsController } from "./audit-logs.controller";
import { AuditLogsService } from "./audit-logs.service";

@Module({
  // DatabaseModule, TenantContextModule, ConfigModule and CommonModule are all
  // @Global, so only the two non-global collaborators are imported here
  // (mirrors ApiKeysModule).
  imports: [AuthModule, AuthorizationModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditModule {}
