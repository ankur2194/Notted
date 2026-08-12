import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

import { AuthEmailQueueHandler } from "../auth/auth-email-worker.service";
import { AuthModule } from "../auth/auth.module";
import { InvitationEmailQueueHandler } from "../memberships/invitation-email-worker.service";
import { MembershipsModule } from "../memberships/memberships.module";

function providerNames(module: object): readonly string[] {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) as readonly unknown[];
  return providers.map((provider) =>
    typeof provider === "function" ? provider.name : "configured-provider",
  );
}

describe("email queue shared-runtime wiring", () => {
  it("wires one concrete handler per pipeline and no standalone BullMQ worker providers", () => {
    const authProviders = providerNames(AuthModule);
    const membershipProviders = providerNames(MembershipsModule);

    expect(authProviders).toContain(AuthEmailQueueHandler.name);
    expect(membershipProviders).toContain(InvitationEmailQueueHandler.name);
    expect(authProviders).not.toContain("AuthEmailQueueService");
    expect(authProviders).not.toContain("AuthEmailDispatcherService");
    expect(membershipProviders).not.toContain("InvitationEmailQueueService");
    expect(membershipProviders).not.toContain("InvitationEmailDispatcherService");
  });
});
