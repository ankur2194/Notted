import { Controller, Delete, Get, Put, Req } from "@nestjs/common";
import { uuidSchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { getRequestId } from "../common/request/request-context";

import { NotePublicLinksService } from "./note-public-links.service";

import type {
  AuthenticatedPrincipal,
  NotePublicLinkCreateResult,
  NotePublicLinkRevokeResult,
  NotePublicLinkStatus,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "noteId"): string {
  return uuidSchema.parse(request.params[key]);
}

const managementAuthorization = {
  action: "note.update" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "note" as const, id: routeUuid(request, "noteId") }),
};

@Controller("workspaces/:workspaceId/notes/:noteId/public-link")
export class NotePublicLinkController {
  constructor(
    private readonly links: NotePublicLinksService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(managementAuthorization)
  status(@Req() request: Request): Promise<NotePublicLinkStatus> {
    return this.links.status(this.scope(request));
  }

  @Put()
  @RequireAuthorization(managementAuthorization)
  create(@Req() request: Request): Promise<NotePublicLinkCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.links.create(this.scope(request));
  }

  @Delete()
  @RequireAuthorization(managementAuthorization)
  revoke(@Req() request: Request): Promise<NotePublicLinkRevokeResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.links.revoke(this.scope(request));
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      noteId: routeUuid(request, "noteId"),
      requestId: getRequestId(request) ?? null,
    };
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }
}
