import { Injectable } from "@nestjs/common";

import { createTenantContext, TenantContextService, type TenantContext } from "../tenant";

import { AuthorizationPolicyService } from "./authorization-policy.service";
import {
  actorFromPrincipal,
  type ApiKeyAuthorizationActor,
  type AuthorizationAction,
  type AuthorizationEvaluation,
  type AuthorizationResourceFacts,
  type AuthorizedOperation,
  type ResourceLocator,
  type SystemAuthorizationActor,
  type UserAuthorizationActor,
} from "./authorization.contracts";
import { AuthorizationDeniedError } from "./authorization.errors";
import { AuthorizationRepository } from "./authorization.repository";

import type { AuthenticatedPrincipal } from "@notted/shared-types";

export interface UserAuthorizationInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly action: AuthorizationAction;
  readonly resource: ResourceLocator;
  readonly requestId?: string | null;
}

export interface UserJobAuthorizationInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly action: AuthorizationAction;
  readonly resource: ResourceLocator;
  readonly correlationId?: string | null;
}

export interface MachineAuthorizationInput<
  T extends ApiKeyAuthorizationActor | SystemAuthorizationActor,
> {
  readonly actor: T;
  readonly action: AuthorizationAction;
  readonly resource: ResourceLocator;
  readonly correlationId?: string | null;
}

function hiddenResource(locator: ResourceLocator): AuthorizationResourceFacts {
  return Object.freeze({
    kind: locator.kind,
    id: "concealed",
    workspaceId: null,
    loadedAt: new Date().toISOString(),
    relationsValid: false,
  });
}

function assertAllowed(
  policy: AuthorizationPolicyService,
  evaluation: AuthorizationEvaluation,
): Extract<ReturnType<AuthorizationPolicyService["decide"]>, { readonly allowed: true }> {
  const decision = policy.decide(evaluation);
  if (!decision.allowed) throw new AuthorizationDeniedError(decision);
  return decision;
}

@Injectable()
export class AuthorizationEntryService {
  constructor(
    private readonly repository: AuthorizationRepository,
    private readonly policy: AuthorizationPolicyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  authorizeUser(input: UserAuthorizationInput): Promise<AuthorizedOperation> {
    return this.authorizeMembershipActor(
      actorFromPrincipal(input.principal),
      input.workspaceId,
      input.action,
      input.resource,
      input.requestId,
    );
  }

  /** User jobs carry identifiers only and recheck live membership and resource facts. */
  authorizeUserJob(input: UserJobAuthorizationInput): Promise<AuthorizedOperation> {
    const actor: UserAuthorizationActor = Object.freeze({
      kind: "user",
      userId: input.userId,
      sessionId: null,
      assurance: "single-factor",
      authenticatedAt: null,
      expiresAt: null,
      isFresh: false,
      source: "user-job",
    });
    return this.authorizeMembershipActor(
      actor,
      input.workspaceId,
      input.action,
      input.resource,
      input.correlationId,
    );
  }

  authorizeApiKey(
    input: MachineAuthorizationInput<ApiKeyAuthorizationActor>,
  ): Promise<AuthorizedOperation> {
    return this.authorizeMachine(input.actor, input.action, input.resource, input.correlationId);
  }

  authorizeSystem(
    input: MachineAuthorizationInput<SystemAuthorizationActor>,
  ): Promise<AuthorizedOperation> {
    return this.authorizeMachine(input.actor, input.action, input.resource, input.correlationId);
  }

  authorizeCurrentUserSession(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly action: "session.list" | "session.revoke";
    readonly sessionId: string;
    readonly targetUserId: string;
  }): AuthorizedOperation {
    const actor = actorFromPrincipal(input.principal);
    const resource: AuthorizationResourceFacts = Object.freeze({
      kind: "session",
      id: input.sessionId,
      workspaceId: null,
      targetUserId: input.targetUserId,
      loadedAt: new Date().toISOString(),
      relationsValid: true,
    });
    const decision = assertAllowed(this.policy, {
      actor,
      action: input.action,
      resource,
      tenant: { workspaceId: null, membershipRole: null, membershipLoadedAt: null },
    });
    return Object.freeze({
      actor,
      action: input.action,
      resource,
      workspaceId: null,
      userId: actor.userId,
      decision,
    });
  }

  run<T>(operation: AuthorizedOperation, work: () => T): T {
    if (operation.workspaceId === null) return work();
    const context = createTenantContext({
      workspaceId: operation.workspaceId,
      userId: operation.userId,
    });
    return this.tenantContext.run(context, work);
  }

  private async authorizeMembershipActor(
    actor: UserAuthorizationActor,
    workspaceId: string,
    action: AuthorizationAction,
    locator: ResourceLocator,
    requestId?: string | null,
  ): Promise<AuthorizedOperation> {
    const membership = await this.repository.findMembership(workspaceId, actor.userId);
    if (membership === null) {
      assertAllowed(this.policy, {
        actor,
        action,
        resource: hiddenResource(locator),
        tenant: { workspaceId, membershipRole: null, membershipLoadedAt: null },
      });
      throw new Error("Unreachable authorization state");
    }

    const context = createTenantContext({ workspaceId, userId: actor.userId, requestId });
    return this.tenantContext.run(context, async () => {
      const resource =
        (await this.repository.loadResource(locator, actor.userId)) ?? hiddenResource(locator);
      const decision = assertAllowed(this.policy, {
        actor,
        action,
        resource,
        tenant: {
          workspaceId,
          membershipRole: membership.role,
          membershipLoadedAt: membership.loadedAt,
        },
      });
      return Object.freeze({
        actor,
        action,
        resource,
        workspaceId,
        userId: actor.userId,
        decision,
      });
    });
  }

  private async authorizeMachine(
    actor: ApiKeyAuthorizationActor | SystemAuthorizationActor,
    action: AuthorizationAction,
    locator: ResourceLocator,
    correlationId?: string | null,
  ): Promise<AuthorizedOperation> {
    const context: TenantContext = createTenantContext({
      workspaceId: actor.workspaceId,
      userId: null,
      requestId: correlationId,
    });
    return this.tenantContext.run(context, async () => {
      const resource =
        (await this.repository.loadResource(locator, null)) ?? hiddenResource(locator);
      const decision = assertAllowed(this.policy, {
        actor,
        action,
        resource,
        tenant: {
          workspaceId: actor.workspaceId,
          membershipRole: null,
          membershipLoadedAt: null,
        },
      });
      return Object.freeze({
        actor,
        action,
        resource,
        workspaceId: actor.workspaceId,
        userId: null,
        decision,
      });
    });
  }
}
