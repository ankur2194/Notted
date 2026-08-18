import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

import { AuthEmailQueueHandler } from "../auth/auth-email-worker.service";
import { AuthModule } from "../auth/auth.module";
import { EmailDeliveryQueueHandler } from "../email/email-delivery.worker.service";
import { EmailModule } from "../email/email.module";
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
    const emailProviders = providerNames(EmailModule);

    expect(authProviders).toContain(AuthEmailQueueHandler.name);
    expect(membershipProviders).toContain(InvitationEmailQueueHandler.name);
    // Part 61's generic `email.deliver` pipeline joins the same convention: one
    // handler registered on the shared runtime, never its own worker.
    expect(emailProviders).toContain(EmailDeliveryQueueHandler.name);
    expect(authProviders).not.toContain("AuthEmailQueueService");
    expect(authProviders).not.toContain("AuthEmailDispatcherService");
    expect(membershipProviders).not.toContain("InvitationEmailQueueService");
    expect(membershipProviders).not.toContain("InvitationEmailDispatcherService");
    expect(emailProviders).not.toContain("EmailDeliveryQueueService");
    expect(emailProviders).not.toContain("EmailDeliveryDispatcherService");
  });
});
