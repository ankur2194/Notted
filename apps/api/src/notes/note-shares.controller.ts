import { Body, Controller, Delete, Get, Put, Req } from "@nestjs/common";
import { upsertNoteShareSchema, uuidSchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";

import { NoteSharesService } from "./note-shares.service";

import type {
  AuthenticatedPrincipal,
  NoteShareDeleteResult,
  NoteShareList,
  NoteShareUpsertResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "noteId" | "userId"): string {
  return uuidSchema.parse(request.params[key]);
}

const managementAuthorization = {
  action: "note.update" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "note" as const, id: routeUuid(request, "noteId") }),
};

// Every route here manages a delegation, so all three declare the same
// management action. `note.share` — what `NoteSharesService.upsert` authorizes
// underneath — cannot be declared at this layer: the policy requires delegation
// facts (target member, requested permission) that only the service has loaded.
// The transport action must therefore never be narrower than the mutation, or
// an API key scoped `read` would satisfy the only scope check on the path.

@Controller("workspaces/:workspaceId/notes/:noteId/shares")
export class NoteSharesController {
  constructor(
    private readonly shares: NoteSharesService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(managementAuthorization)
  list(@Req() request: Request): Promise<NoteShareList> {
    return this.shares.list(this.scope(request));
  }

  @Put(":userId")
  @RequireAuthorization(managementAuthorization)
  upsert(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteShareUpsertResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = upsertNoteShareSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.shares.upsert({
      ...this.scope(request),
      userId: routeUuid(request, "userId"),
      permission: body.data.permission,
    });
  }

  @Delete(":userId")
  @RequireAuthorization(managementAuthorization)
  revoke(@Req() request: Request): Promise<NoteShareDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.shares.revoke({ ...this.scope(request), userId: routeUuid(request, "userId") });
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

  private invalid(): never {
    throw new ApiHttpException(400, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
