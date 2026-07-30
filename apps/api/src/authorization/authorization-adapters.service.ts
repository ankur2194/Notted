import { Injectable } from "@nestjs/common";

import { AuthorizationEntryService } from "./authorization-entry.service";

import type {
  UserAuthorizationInput,
  UserJobAuthorizationInput,
} from "./authorization-entry.service";
import type {
  ApiKeyAuthorizationActor,
  AuthorizationAction,
  AuthorizedOperation,
  ResourceLocator,
  SystemAuthorizationActor,
} from "./authorization.contracts";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

export interface TransportAuthorizationInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly action: AuthorizationAction;
  readonly resource: ResourceLocator;
  readonly correlationId?: string | null;
}

/**
 * Framework-neutral entry contracts. Owning transport parts wire these methods
 * rather than copying role, membership, project, share, or tenant logic.
 */
@Injectable()
export class AuthorizationAdaptersService {
  constructor(private readonly entry: AuthorizationEntryService) {}

  authorizeHttp(input: TransportAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUser(this.userInput(input));
  }

  authorizeRest(input: TransportAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUser(this.userInput(input));
  }

  authorizeTrpc(input: TransportAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUser(this.userInput(input));
  }

  authorizeSocketJoin(input: TransportAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUser(this.userInput(input));
  }

  authorizeSocketMessage(input: TransportAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUser(this.userInput(input));
  }

  authorizeFile(input: TransportAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUser(this.userInput(input));
  }

  authorizeUserJob(input: UserJobAuthorizationInput): Promise<AuthorizedOperation> {
    return this.entry.authorizeUserJob(input);
  }

  authorizeSystemJob(input: {
    readonly actor: SystemAuthorizationActor;
    readonly action: AuthorizationAction;
    readonly resource: ResourceLocator;
    readonly correlationId?: string | null;
  }): Promise<AuthorizedOperation> {
    return this.entry.authorizeSystem(input);
  }

  authorizeApiKey(input: {
    readonly actor: ApiKeyAuthorizationActor;
    readonly action: AuthorizationAction;
    readonly resource: ResourceLocator;
    readonly correlationId?: string | null;
  }): Promise<AuthorizedOperation> {
    return this.entry.authorizeApiKey(input);
  }

  authorizeCurrentUserSession(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly action: "session.list" | "session.revoke";
    readonly sessionId: string;
    readonly targetUserId: string;
  }): AuthorizedOperation {
    return this.entry.authorizeCurrentUserSession(input);
  }

  run<T>(operation: AuthorizedOperation, work: () => T): T {
    return this.entry.run(operation, work);
  }

  private userInput(input: TransportAuthorizationInput): UserAuthorizationInput {
    return {
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: input.action,
      resource: input.resource,
      requestId: input.correlationId,
    };
  }
}
