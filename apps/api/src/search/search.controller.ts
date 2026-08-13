// Part 52.2 — internal session-authenticated REST controller for workspace
// search.
//
// Routes:
//   GET  /api/v1/workspaces/:workspaceId/search
//        → authorized full-text search; returns SearchPage.
//   GET  /api/v1/workspaces/:workspaceId/search/suggestions
//        → authorized title/prefix suggestions; returns SearchSuggestion[].
//
// Transport is THIN: it parses the route UUID, validates the query with the
// shared Zod schema, reads the authorized operation attached by the guard
// (which carries the principal + workspace role + workspace id), and delegates
// to `SearchService`. The `AuthorizationHttpInterceptor` already established
// the tenant scope by the time the handler runs.
//
// There is intentionally no tRPC router and no public API-key surface here.
// Part 65 wires the public REST API; this controller is the internal session
// surface the web app uses.

import { Controller, Get, HttpStatus, Query, Req } from "@nestjs/common";
import {
  searchQuerySchema,
  searchSuggestionQuerySchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { getAuthorizedOperation } from "../authorization/authorization-http.context";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";

import { SearchService } from "./search.service";

import type { SearchPage, SearchSuggestion } from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

const workspaceAuthorization = () => ({
  action: "workspace.read" as const,
  workspaceId: (request: Request) => routeUuid(request),
  resource: () => ({ kind: "workspace" as const }),
});

@Controller("workspaces/:workspaceId/search")
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization())
  search(@Req() request: Request, @Query() rawQuery: unknown): Promise<SearchPage> {
    const query = searchQuerySchema.safeParse({
      ...(typeof rawQuery === "object" && rawQuery !== null ? rawQuery : {}),
      workspaceId: routeUuid(request),
    });
    if (!query.success) this.invalid();
    const scope = this.scope(request);
    return this.searchService.search(
      {
        workspaceId: scope.workspaceId,
        query: query.data.query,
        mode: query.data.mode,
        filters: {
          ...(query.data.projectId === undefined ? {} : { projectId: query.data.projectId }),
          ...(query.data.authorId === undefined ? {} : { authorId: query.data.authorId }),
          ...(query.data.hasAttachments === undefined
            ? {}
            : { hasAttachments: query.data.hasAttachments }),
          ...(query.data.createdFrom === undefined
            ? {}
            : { createdFrom: Date.parse(query.data.createdFrom) }),
          ...(query.data.createdTo === undefined
            ? {}
            : { createdTo: Date.parse(query.data.createdTo) }),
          ...(query.data.updatedFrom === undefined
            ? {}
            : { updatedFrom: Date.parse(query.data.updatedFrom) }),
          ...(query.data.updatedTo === undefined
            ? {}
            : { updatedTo: Date.parse(query.data.updatedTo) }),
        },
        sort: {
          sortBy: query.data.sortBy,
          sortDirection: query.data.sortDirection,
        },
        page: query.data.page,
        limit: query.data.limit,
      },
      {
        principal: scope.principal,
        membershipRole: scope.membershipRole,
        requestId: scope.requestId,
      },
    );
  }

  @Get("suggestions")
  @RequireAuthorization(workspaceAuthorization())
  suggestions(
    @Req() request: Request,
    @Query() rawQuery: unknown,
  ): Promise<readonly SearchSuggestion[]> {
    const query = searchSuggestionQuerySchema.safeParse({
      ...(typeof rawQuery === "object" && rawQuery !== null ? rawQuery : {}),
      workspaceId: routeUuid(request),
    });
    if (!query.success) this.invalid();
    const scope = this.scope(request);
    return this.searchService.suggest(
      {
        workspaceId: scope.workspaceId,
        query: query.data.query,
        limit: query.data.limit,
      },
      {
        principal: scope.principal,
        membershipRole: scope.membershipRole,
        requestId: scope.requestId,
      },
    );
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }

  /**
   * Resolve the principal + workspace role + workspace id from the request.
   * The guard has already proven membership and stored the authorized
   * operation on the request; we read the role from there rather than
   * re-querying. The principal is attached by the auth middleware.
   */
  private scope(request: Request): {
    readonly principal: NonNullable<ReturnType<typeof getAuthPrincipal>>;
    readonly workspaceId: string;
    readonly membershipRole: NonNullable<
      NonNullable<ReturnType<typeof getAuthorizedOperation>>["membershipRole"]
    >;
    readonly requestId: string | null;
  } {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) {
      throw new Error("Authorization guard did not attach a principal");
    }
    const operation = getAuthorizedOperation(request);
    if (operation === undefined) {
      throw new ApiHttpException(HttpStatus.FORBIDDEN, {
        code: "FORBIDDEN",
        message: "You are not allowed to do that.",
      });
    }
    if (operation.membershipRole === null) {
      // The guard should only set a non-null role for user actors on
      // workspace.read. A null role means the actor is system or API-key; the
      // Part 52 internal session controller does not serve those actors.
      throw new ApiHttpException(HttpStatus.FORBIDDEN, {
        code: "FORBIDDEN",
        message: "You are not allowed to do that.",
      });
    }
    const workspaceId = routeUuid(request);
    return {
      principal,
      workspaceId,
      membershipRole: operation.membershipRole,
      requestId: getRequestId(request) ?? null,
    };
  }
}
