// Part 67 — the workspace AI surface over the versioned REST API.
//
// REST only, no tRPC subrouter: `apps/web` reaches this from workspace settings
// through the same REST client the sibling admin surfaces (API keys, webhooks,
// exports, notifications) use, and a second transport with no caller is a
// second thing to keep authorized.
//
// EVERY HANDLER CARRIES `@RequireAuthorization`, WITHOUT EXCEPTION. Part 65's
// `ApiKeyRouteGuard` is a default-deny APP_GUARD: an API-key request may only
// reach a handler that carries `AUTHORIZATION_HTTP_SPEC` metadata, so a missing
// decorator does not merely skip a check — it makes the route 403 for every API
// key while still serving session callers. That asymmetry is exactly the kind
// of bug nobody notices for a month.
//
// TWO ACTIONS, TWO AUDIENCES. `ai.configure` is owner/admin and `HIGH_RISK`
// (so it demands a fresh session) because it writes provider key material;
// `ai.use` reaches editors and backs the deliberately thin `GET status`.
// Nothing in this file re-implements any of that.
//
// `PUT`, not `PATCH`: `aiConfigUpdateSchema` is the whole desired
// configuration, so the write is a replacement and the verb should say so.

import { Body, Controller, Get, HttpStatus, Post, Put, Query, Req, Res } from "@nestjs/common";
import {
  aiConfigUpdateSchema,
  aiContinueRequestSchema,
  aiGrammarCheckRequestSchema,
  aiMeetingExtractionRequestSchema,
  aiRewriteRequestSchema,
  aiSummarizeRequestSchema,
  aiTagSuggestionRequestSchema,
  aiUsageQuerySchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";
import { getRequestId } from "../common/request/request-context";

import { buildContinuePrompt, buildRewritePrompt, buildSummarizePrompt } from "./ai-prompts";
import { AiStreamService } from "./ai-stream.service";
import { AiService } from "./ai.service";
import { GrammarService } from "./grammar.service";
import { MeetingExtractionService } from "./meeting-extraction.service";

import type { AiPromptPlan } from "./ai-prompts";
import type {
  AiConfigView,
  AiStatus,
  AiUsageSummary,
  AuthenticatedPrincipal,
  GrammarCheckResult,
  MeetingExtractionResult,
  TagSuggestionResult,
} from "@notted/shared-types";
import type { Request, Response } from "express";

function routeUuid(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

/** Every route on this controller addresses the workspace itself. */
const workspaceAuthorization = (action: "ai.configure" | "ai.use") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request),
  resource: () => ({ kind: "workspace" as const }),
});

@Controller("workspaces/:workspaceId/ai")
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly auth: AuthService,
    private readonly stream: AiStreamService,
    private readonly meetings: MeetingExtractionService,
    private readonly grammar: GrammarService,
  ) {}

  @Get("config")
  @RequireAuthorization(workspaceAuthorization("ai.configure"))
  getConfig(@Req() request: Request): Promise<AiConfigView> {
    return this.ai.getConfig(this.scope(request));
  }

  /**
   * `sensitive` tier: this is the route a stolen admin session would use to
   * swap in an attacker's provider key, and it is the only route in the product
   * that accepts one. It should not be reachable at the general allowance.
   */
  @Put("config")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.configure"))
  updateConfig(@Req() request: Request, @Body() rawBody: unknown): Promise<AiConfigView> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiConfigUpdateSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.ai.updateConfig({ ...this.scope(request), ...body.data });
  }

  /**
   * `sensitive` tier as well, despite being a read: it aggregates across the
   * whole `ai_usage` table for the workspace over a window the caller chooses,
   * so it is the most expensive query on this surface by a wide margin.
   */
  @Get("usage")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.configure"))
  getUsage(@Req() request: Request, @Query() rawQuery: unknown): Promise<AiUsageSummary> {
    const query = aiUsageQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.ai.getUsage({ ...this.scope(request), ...query.data });
  }

  @Get("status")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  getStatus(@Req() request: Request): Promise<AiStatus> {
    return this.ai.getStatus(this.scope(request));
  }

  /**
   * Part 68 — the three streaming authoring features.
   *
   * `@Res()` HANDS NEST'S RESPONSE HANDLING TO US, deliberately: an event
   * stream is written frame by frame and cannot go through the interceptor that
   * serialises a return value. `AiStreamService` still refuses everything it is
   * going to refuse before it writes a byte, so a governance refusal is thrown
   * from here and answered by the global exception filter as ordinary JSON.
   *
   * `sensitive` tier and a trusted-origin check on all three: these are POSTs
   * that spend a workspace's money at a third party, so the general allowance is
   * the wrong ceiling and a cross-site form post is not an acceptable trigger.
   *
   * `ai.use`, not `ai.configure` — an editor may generate text; only an admin
   * may change who pays for it. The note itself is authorized separately inside
   * the service, because `workspaceAuthorization` addresses the workspace.
   */
  @Post("summarize")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  summarize(
    @Req() request: Request,
    @Res() response: Response,
    @Body() rawBody: unknown,
  ): Promise<void> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiSummarizeRequestSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.run(request, response, body.data.noteId, buildSummarizePrompt(body.data));
  }

  @Post("continue")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  continueWriting(
    @Req() request: Request,
    @Res() response: Response,
    @Body() rawBody: unknown,
  ): Promise<void> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiContinueRequestSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.run(request, response, body.data.noteId, buildContinuePrompt(body.data));
  }

  @Post("rewrite")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  rewrite(
    @Req() request: Request,
    @Res() response: Response,
    @Body() rawBody: unknown,
  ): Promise<void> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiRewriteRequestSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.run(request, response, body.data.noteId, buildRewritePrompt(body.data));
  }

  /**
   * Part 69 — the two JSON features.
   *
   * NO `@Res()` HERE, deliberately. These answer with a value, so they go
   * through Nest's ordinary serialisation and the global exception filter can
   * still turn a governance refusal, a provider failure or an unreadable model
   * reply into a normal error envelope — the thing the streaming routes give up
   * in exchange for streaming (ADR 0013).
   *
   * Same tier and the same trusted-origin check as the streaming three, and for
   * the same reason: both spend a workspace's money at a third party, and both
   * may run TWO provider calls when the first reply needs repairing.
   */
  @Post("meeting-extraction")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  extractMeeting(
    @Req() request: Request,
    @Body() rawBody: unknown,
  ): Promise<MeetingExtractionResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiMeetingExtractionRequestSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.meetings.extract({ ...this.scope(request), transcript: body.data.transcript });
  }

  @Post("tag-suggestions")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  suggestTags(@Req() request: Request, @Body() rawBody: unknown): Promise<TagSuggestionResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiTagSuggestionRequestSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    // `noteId` is authorized for `note.read` inside the service — the route's
    // own spec addresses the workspace, not the note.
    return this.meetings.suggestTags({ ...this.scope(request), ...body.data });
  }

  /**
   * Part 70 — the grammar check. A third JSON route, and the same shape as the
   * two above: ordinary serialisation, `sensitive` tier, trusted origin, `ai.use`.
   *
   * No note is named and none is authorized. The request carries its own
   * segments — blocks the browser batched, possibly from a document that has not
   * been saved — so the workspace-level spec on this handler is the tenancy
   * proof, exactly as it is for `meeting-extraction`.
   */
  @Post("grammar-check")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  checkGrammar(@Req() request: Request, @Body() rawBody: unknown): Promise<GrammarCheckResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiGrammarCheckRequestSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.grammar.check({ ...this.scope(request), segments: body.data.segments });
  }

  private run(
    request: Request,
    response: Response,
    noteId: string,
    prompt: AiPromptPlan,
  ): Promise<void> {
    return this.stream.run({ ...this.scope(request), noteId, prompt, response });
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request),
      requestId: getRequestId(request) ?? null,
    };
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
