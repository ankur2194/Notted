// Part 67: provider-neutral AI configuration, governance, and the chat seam.
//
// DEPENDENCY DIRECTION — every arrow points INTO this module. It imports the
// shared auth/authorization primitives and `QueueModule` (for the deployment's
// per-provider allowance), and nothing from the note, project or workspace
// modules: governance needs a workspace id and a feature name, never a domain
// service. Part 68's AI features import this one, not the reverse, which keeps
// the graph acyclic with no `forwardRef`.
//
// WHAT IS EXPORTED, AND WHY. `AiService` (the admin surface), plus the three
// pieces Part 68's streaming endpoints are built on: `AiGovernanceService` for
// the fail-closed gate, `AiChatProviderRegistry` for the provider adapters, and
// `AiCredentialService` because a future rotation job will need to re-encrypt
// rows. Nothing else leaves this module.

import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RedisModule } from "../infrastructure/redis/redis.module";
import { QueueModule } from "../queue/queue.module";

import { AiCredentialService } from "./ai-credential.service";
import { AiGovernanceService } from "./ai-governance.service";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { AiChatProviderRegistry, AnthropicChatProvider, OpenAiChatProvider } from "./providers";

@Module({
  // QueueModule supplies AiProviderRateLimiterService (the deployment-wide
  // per-provider allowance) and RedisModule supplies the `REDIS_CLIENT` token
  // the per-workspace window increments directly — QueueModule imports Redis
  // but does not re-export the token, and depending on a transitive import
  // would break the moment that stopped being true. DatabaseModule,
  // TenantContextModule, ConfigModule and CommonModule are all @Global, so
  // they need no import.
  imports: [AuthModule, AuthorizationModule, QueueModule, RedisModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiGovernanceService,
    AiCredentialService,
    OpenAiChatProvider,
    AnthropicChatProvider,
    AiChatProviderRegistry,
  ],
  exports: [AiService, AiGovernanceService, AiCredentialService, AiChatProviderRegistry],
})
export class AiModule {}
