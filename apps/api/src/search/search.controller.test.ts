import { HttpStatus, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { setAuthorizedOperation } from "../authorization/authorization-http.context";
import { AUTHORIZATION_HTTP_SPEC } from "../authorization/authorization-http.decorator";

import { SearchController } from "./search.controller";

import type { SearchService } from "./search.service";
import type { AuthorizedOperation } from "../authorization/authorization.contracts";
import type { AuthenticatedPrincipal, SearchPage } from "@notted/shared-types";
import type { Request } from "express";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const USER_ID = "22222222-0000-4000-8000-000000000002";
const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session-1",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});

const EMPTY_PAGE: SearchPage = Object.freeze({
  items: [],
  page: 1,
  limit: 25,
  total: 0,
  hasMore: false,
  availability: Object.freeze({
    textSearchAvailable: true,
    mode: "full-text",
    fallback: "none",
  }),
});

function request(params: Record<string, string>): Request {
  const value = {
    params,
    header: () => undefined,
  } as unknown as Request;
  setAuthPrincipal(value, PRINCIPAL);
  // Lean authorized-operation double: the controller reads only
  // `membershipRole` and `workspaceId` from the operation; the actor and
  // resource fields are not exercised by this test, so we cast through
  // `unknown` to avoid constructing a full `UserAuthorizationActor`.
  const operation = {
    kind: "authorized-operation",
    membershipRole: "editor",
    workspaceId: WORKSPACE_ID,
  } as unknown as AuthorizedOperation;
  setAuthorizedOperation(value, operation);
  return value;
}

describe("SearchController", () => {
  it("registers GET handlers at the workspace search routes", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SearchController)).toBe(
      "workspaces/:workspaceId/search",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, SearchController.prototype.search)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, SearchController.prototype.suggestions)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, SearchController.prototype.suggestions)).toBe(
      "suggestions",
    );
    expect(Reflect.getMetadata(PATH_METADATA, SearchController.prototype.search)).toBe("/");
  });

  it("authorizes workspace.read on both handlers", () => {
    const searchSpec = Reflect.getMetadata(
      AUTHORIZATION_HTTP_SPEC,
      SearchController.prototype.search,
    );
    const suggestSpec = Reflect.getMetadata(
      AUTHORIZATION_HTTP_SPEC,
      SearchController.prototype.suggestions,
    );
    expect(searchSpec.action).toBe("workspace.read");
    expect(suggestSpec.action).toBe("workspace.read");
  });

  it("delegates a valid search query to SearchService and returns its page", async () => {
    const search = vi.fn().mockResolvedValue(EMPTY_PAGE);
    const controller = new SearchController({ search } as unknown as SearchService);

    const result = await controller.search(request({ workspaceId: WORKSPACE_ID }), {
      query: "release notes",
      mode: "full-text",
      page: "1",
      limit: "25",
      sortBy: "relevance",
      sortDirection: "desc",
    });

    expect(result).toBe(EMPTY_PAGE);
    expect(search).toHaveBeenCalledTimes(1);
    const call = search.mock.calls[0];
    expect(call?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      query: "release notes",
      mode: "full-text",
      page: 1,
      limit: 25,
      sort: { sortBy: "relevance", sortDirection: "desc" },
    });
    expect(call?.[1]).toMatchObject({
      membershipRole: "editor",
      principal: PRINCIPAL,
    });
  });

  it("uses the route workspace and rejects a conflicting query workspace", () => {
    const search = vi.fn();
    const controller = new SearchController({ search } as unknown as SearchService);
    expect(() =>
      controller.search(request({ workspaceId: WORKSPACE_ID }), {
        workspaceId: "33333333-0000-4000-8000-000000000003",
        query: "release notes",
      }),
    ).not.toThrow();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      expect.anything(),
    );
  });

  it("parses ISO timestamp filters into epoch-ms", async () => {
    const search = vi.fn().mockResolvedValue(EMPTY_PAGE);
    const controller = new SearchController({ search } as unknown as SearchService);

    await controller.search(request({ workspaceId: WORKSPACE_ID }), {
      query: "x",
      createdFrom: "2026-01-01T00:00:00.000Z",
      createdTo: "2026-02-01T00:00:00.000Z",
      updatedFrom: "2026-03-01T00:00:00.000Z",
      updatedTo: "2026-04-01T00:00:00.000Z",
    });

    const filters = search.mock.calls[0]?.[0].filters as Record<string, unknown>;
    expect(filters.createdFrom).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(filters.createdTo).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(filters.updatedFrom).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
    expect(filters.updatedTo).toBe(Date.parse("2026-04-01T00:00:00.000Z"));
  });

  it("rejects an invalid query with HTTP 400", async () => {
    const search = vi.fn();
    const controller = new SearchController({ search } as unknown as SearchService);

    expect(() =>
      controller.search(request({ workspaceId: WORKSPACE_ID }), {
        // Missing the required `query`.
        page: "1",
      }),
    ).toThrow(expect.objectContaining({ status: HttpStatus.BAD_REQUEST }));
    expect(search).not.toHaveBeenCalled();
  });

  it("delegates a valid suggestions query", async () => {
    const suggest = vi.fn().mockResolvedValue([]);
    const controller = new SearchController({
      suggest,
    } as unknown as SearchService);

    await controller.suggestions(request({ workspaceId: WORKSPACE_ID }), {
      query: "rel",
      limit: "8",
    });

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      query: "rel",
      limit: 8,
    });
  });

  it("rejects an empty suggestions query", () => {
    const controller = new SearchController({ suggest: vi.fn() } as unknown as SearchService);
    expect(() =>
      controller.suggestions(request({ workspaceId: WORKSPACE_ID }), { query: "" }),
    ).toThrow(expect.objectContaining({ status: HttpStatus.BAD_REQUEST }));
  });

  it("returns HTTP 403 when no authorized operation is attached", () => {
    const controller = new SearchController({ search: vi.fn() } as unknown as SearchService);
    const requestNoOp = {
      params: { workspaceId: WORKSPACE_ID },
      header: () => undefined,
    } as unknown as Request;
    setAuthPrincipal(requestNoOp, PRINCIPAL);
    // Note: no setAuthorizedOperation call.
    expect(() => controller.search(requestNoOp, { query: "x" })).toThrow(
      expect.objectContaining({ status: HttpStatus.FORBIDDEN }),
    );
  });
});
