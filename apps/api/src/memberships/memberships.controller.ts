import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  acceptWorkspaceInvitationSchema,
  changeWorkspaceMemberRoleSchema,
  invitationListQuerySchema,
  inviteWorkspaceMemberSchema,
  membershipListQuerySchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthGuard } from "../auth/auth.guard";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";

import { MembershipsService } from "./memberships.service";

import type {
  AuthenticatedPrincipal,
  WorkspaceInvitationAcceptResult,
  WorkspaceInvitationPage,
  WorkspaceInvitationResendResult,
  WorkspaceInvitationRevokeResult,
  WorkspaceInviteResult,
  WorkspaceMemberLeaveResult,
  WorkspaceMemberPage,
  WorkspaceMemberRemoveResult,
  WorkspaceMemberRoleChangeResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "memberId" | "invitationId"): string {
  return uuidSchema.parse(request.params[key]);
}

const listAuthorization = {
  action: "member.list" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
};
const inviteAuthorization = {
  action: "member.invite" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
};
const invitationListAuthorization = {
  action: "member.invite" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
};
const updateAuthorization = {
  action: "member.update" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "member" as const, id: routeUuid(request, "memberId") }),
};
const removeAuthorization = {
  action: "member.remove" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "member" as const, id: routeUuid(request, "memberId") }),
};

/** Thin REST transport. All invariants and transactions remain in the service. */
@Controller()
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly auth: AuthService,
  ) {}

  @Get("workspaces/:workspaceId/members")
  @RequireAuthorization(listAuthorization)
  listMembers(@Req() request: Request, @Query() rawQuery: unknown): Promise<WorkspaceMemberPage> {
    const query = membershipListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.memberships.listMembers({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      page: query.data.page,
      limit: query.data.limit,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Get("workspaces/:workspaceId/invitations")
  @RequireAuthorization(invitationListAuthorization)
  listInvitations(
    @Req() request: Request,
    @Query() rawQuery: unknown,
  ): Promise<WorkspaceInvitationPage> {
    const query = invitationListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.memberships.listInvitations({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      page: query.data.page,
      limit: query.data.limit,
      status: query.data.status,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Post("workspaces/:workspaceId/invitations")
  @RequireAuthorization(inviteAuthorization)
  invite(@Req() request: Request, @Body() rawBody: unknown): Promise<WorkspaceInviteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = inviteWorkspaceMemberSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.memberships.invite({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      email: body.data.email,
      role: body.data.role,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Post("workspaces/:workspaceId/invitations/:invitationId/resend")
  @RequireAuthorization(inviteAuthorization)
  resend(@Req() request: Request): Promise<WorkspaceInvitationResendResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.memberships.resend({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      invitationId: routeUuid(request, "invitationId"),
      requestId: getRequestId(request) ?? null,
    });
  }

  @Delete("workspaces/:workspaceId/invitations/:invitationId")
  @RequireAuthorization(inviteAuthorization)
  revoke(@Req() request: Request): Promise<WorkspaceInvitationRevokeResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.memberships.revoke({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      invitationId: routeUuid(request, "invitationId"),
      requestId: getRequestId(request) ?? null,
    });
  }

  @Post("invitations/accept")
  @UseGuards(AuthGuard)
  accept(
    @Req() request: Request,
    @Body() rawBody: unknown,
  ): Promise<WorkspaceInvitationAcceptResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = acceptWorkspaceInvitationSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.memberships.accept({
      principal: this.principal(request),
      token: body.data.token,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Patch("workspaces/:workspaceId/members/:memberId")
  @RequireAuthorization(updateAuthorization)
  changeRole(
    @Req() request: Request,
    @Body() rawBody: unknown,
  ): Promise<WorkspaceMemberRoleChangeResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = changeWorkspaceMemberRoleSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.memberships.changeRole({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      memberId: routeUuid(request, "memberId"),
      role: body.data.role,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Delete("workspaces/:workspaceId/members/:memberId")
  @RequireAuthorization(removeAuthorization)
  remove(@Req() request: Request): Promise<WorkspaceMemberRemoveResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.memberships.remove({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      memberId: routeUuid(request, "memberId"),
      requestId: getRequestId(request) ?? null,
    });
  }

  @Post("workspaces/:workspaceId/members/leave")
  @RequireAuthorization(listAuthorization)
  leave(@Req() request: Request): Promise<WorkspaceMemberLeaveResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.memberships.leave({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      requestId: getRequestId(request) ?? null,
    });
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authentication guard did not attach a principal");
    return principal;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
