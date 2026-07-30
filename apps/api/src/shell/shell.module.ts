import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { ShellController } from "./shell.controller";
import { ShellService } from "./shell.service";

@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [ShellController],
  providers: [ShellService],
  exports: [ShellService],
})
export class ShellModule {}
