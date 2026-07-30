import { Module } from "@nestjs/common";

import { AuthorizationPolicyService } from "./authorization-policy.service";

@Module({
  providers: [AuthorizationPolicyService],
  exports: [AuthorizationPolicyService],
})
export class AuthorizationPolicyModule {}
