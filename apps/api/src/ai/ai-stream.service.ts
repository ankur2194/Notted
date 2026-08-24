// Part 68 — one streamed generation, from authorization to the metered row.
//
// THE ORDER OF THE FIRST FOUR STEPS IS THE DESIGN. Authorize, then acquire the
// governance grant, then resolve the provider, and ONLY THEN turn the response
// into an event stream. Every refusal therefore happens while the response is
// still a normal JSON response, which is what lets `AiGovernanceRefusal` — a
// plain `ApiHttpException` — be answered by the global exception filter as an
// ordinary 4xx envelope with a stable code the client already knows how to
// render. Flush a single SSE byte before that point and the refusal becomes a
// 200 with an error frame inside it: every client would need a second error
// path, and any proxy or `fetch` wrapper in between would report success.
//
// EXACTLY ONE USAGE ROW, ON EVERY PATH. `recordUsage` is idempotent by
// construction (see `ai-governance.service.ts`), but idempotent is not the same
// as called: a `finally` is what makes a cancelled stream, a provider blow-up
// and a clean finish all reach the meter. A generation that streamed 4 000
// characters and then had its socket closed still cost the workspace money.
//
// NOTHING FROM THE MODEL, THE PROMPT, OR THE PROVIDER IS LOGGED. The one log
// line carries a workspace id, a feature name and a status. Error copy sent to
// the client is looked up from the provider's error CODE — never built from a
// provider response body, which quotes the request (and therefore the note)
// back at us.

import { HttpStatus, Injectable } from "@nestjs/common";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { StructuredLogger } from "../common/logging/structured-logger.service";

import {
  AiGovernanceRefusal,
  AiGovernanceService,
  type AiRuntimeGrant,
  type AiUsageOutcome,
} from "./ai-governance.service";
import { AiChatProviderError, AiChatProviderRegistry } from "./providers";

import type { AiPromptFeature, AiPromptPlan } from "./ai-prompts";
import type {
  AiProviderErrorCode,
  AiStreamErrorCode,
  AiStreamEvent,
  AuthenticatedPrincipal,
} from "@notted/shared-types";
import type { Response } from "express";

export interface AiStreamRunInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly requestId: string | null;
  readonly prompt: AiPromptPlan;
  readonly response: Response;
}

/**
 * Part 69 — the same generation, collected instead of streamed.
 *
 * WHY A SECOND ENTRY POINT AND NOT A SECOND SERVICE. Authorization, the
 * fail-closed governance gate, provider resolution and "exactly one `ai_usage`
 * row on every path" are the same four obligations whether the answer is
 * streamed to a browser or parsed into an object. A second service would be a
 * second place for one of them to be forgotten.
 */
export interface AiCompletionInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  /**
   * Authorized for `note.read` when present, which is what proves the caller may
   * work in this tenant on this note. Omitted (or null) when the request names
   * no note at all — a pasted meeting transcript belongs to nothing yet — in
   * which case the route's own `ai.use` workspace authorization is the only
   * tenancy proof, and it is sufficient: nothing note-scoped is read.
   */
  readonly noteId?: string | null;
  readonly requestId: string | null;
  readonly prompt: AiPromptPlan;
}

export interface AiCompletion {
  readonly text: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * Client-facing copy for a provider failure, keyed by the CODE and nothing
 * else. `AiChatProviderError` is built from an HTTP status alone precisely so
 * that this map is the only place a human-readable sentence exists.
 */
const PROVIDER_MESSAGE: Readonly<Record<AiProviderErrorCode, string>> = Object.freeze({
  auth: "The AI provider rejected this workspace's credential. An administrator needs to update it.",
  rate_limited: "The AI provider is rate limiting this workspace. Try again shortly.",
  overloaded: "The AI provider is busy. Try again shortly.",
  invalid_request: "The AI provider rejected this request.",
  network: "The connection to the AI provider failed before the answer was complete.",
});

const STREAM_MESSAGE: Readonly<Record<Exclude<AiStreamErrorCode, "ai_provider_error">, string>> =
  Object.freeze({
    ai_output_empty: "The model returned no text.",
    ai_output_truncated: "The generated text reached this server's length limit and was stopped.",
  });

/** `ai_usage.error_code` for a stream the reader walked away from. */
const CLIENT_CANCELLED = "client_cancelled";

/**
 * ponytail: a cancelled stream's completion tokens are estimated at four
 * characters per token, because no provider reports usage for a request the
 * caller aborted mid-flight. The ceiling is a metering error of roughly ±50%
 * on partial generations only — every completed generation uses the provider's
 * own numbers. Upgrade path: use the provider's reported usage on partial
 * streams as soon as the APIs offer it, which is a one-line change here.
 */
const CANCELLED_CHARS_PER_TOKEN = 4;

interface StreamUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

@Injectable()
export class AiStreamService {
  constructor(
    private readonly authorization: AuthorizationEntryService,
    private readonly governance: AiGovernanceService,
    private readonly providers: AiChatProviderRegistry,
    private readonly logger: StructuredLogger,
  ) {}

  async run(input: AiStreamRunInput): Promise<void> {
    const { prompt, response } = input;

    // 1. Tenancy and read permission on the note, before anything else. A
    // foreign or missing note id resolves to concealed resource facts inside
    // the authorization layer and is denied there, so this one call is both the
    // permission check and the proof the note belongs to this workspace. The
    // denial propagates as the same 403/404 every other note route produces.
    await this.authorization.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "note.read",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });

    // 2. The fail-closed governance gate. Still pre-SSE, deliberately.
    const grant = await this.acquire({
      workspaceId: input.workspaceId,
      userId: input.principal.userId,
      feature: prompt.feature,
      response,
    });

    // 3. The adapter. `null` means the stored provider is `disabled`, which the
    // gate should already have refused — reaching here means the row changed
    // under us, so fail closed with the same answer an unconfigured workspace
    // gets, and meter the refusal because a grant was already issued.
    const provider = this.providers.resolve(grant.provider);
    if (provider === null) {
      await grant.recordUsage({ status: "failed", errorCode: "ai_not_configured" });
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "AI_NOT_CONFIGURED",
        message: "AI is not configured for this workspace.",
      });
    }

    // 4. Past this line the response is an event stream and no exception can be
    // turned back into a JSON envelope.
    response.status(HttpStatus.OK);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    /*
     * `no-transform` IS LOAD-BEARING, NOT DECORATION. `main.ts` installs
     * `compression()` globally, and `text/event-stream` is absent from
     * `mime-db`, so `compressible` falls back to its `/^text\//` regexp and
     * happily compresses this response. A gzip stream only flushes on an
     * explicit `res.flush()` or on `end()`, so every delta would be held until
     * the generation finished — the feature would still "work" and stream
     * nothing, and a cancelled request would deliver zero bytes.
     *
     * `no-transform` is the one condition `compression`'s `shouldTransform`
     * checks (its `cacheControlNoTransformRegExp`), so this header is what keeps
     * the middleware's hands off. `X-Accel-Buffering` below solves the same
     * problem one hop further out, at nginx; neither substitutes for the other.
     */
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    // Nginx buffers proxied responses by default, which would hold the whole
    // generation until it finished and defeat the point of streaming.
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    // 5. Registered BEFORE the first provider await: a reader who closes the
    // tab during the connection handshake must still stop the generation, and a
    // listener attached afterwards would miss that window entirely.
    const controller = new AbortController();
    let cancelled = false;
    const onClose = (): void => {
      cancelled = true;
      controller.abort();
    };
    response.on("close", onClose);

    let streamedChars = 0;
    let sawContent = false;
    let usage: StreamUsage | null = null;
    let streamError: AiStreamErrorCode | null = null;
    let providerCode: AiProviderErrorCode | null = null;

    try {
      for await (const event of provider.stream(
        {
          model: grant.model,
          apiKey: grant.apiKey,
          system: prompt.system,
          messages: prompt.messages,
          maxOutputTokens: prompt.maxOutputTokens,
        },
        controller.signal,
      )) {
        if (event.type === "usage") {
          // The LAST usage event wins: Anthropic splits it across two frames.
          usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
          continue;
        }
        // 6. The server's own ceiling. `maxOutputTokens` is a request to the
        // provider and providers have been known to overshoot it; this is the
        // limit we control. The overshooting delta is dropped rather than
        // clipped — a half-sentence the client cannot tell is half is worse
        // than an explicit truncation frame.
        if (streamedChars + event.text.length > prompt.maxOutputChars) {
          streamError = "ai_output_truncated";
          /*
           * The frame goes out BEFORE the break, not after the loop. `break` on
           * a `for await` awaits the iterator's `return()`, and a provider
           * cleaning up an aborted `fetch` body can throw from there — which
           * would skip every statement after the loop and leave the client with
           * a stream that simply stopped. Telling the client first costs
           * nothing and cannot be jumped over.
           */
          this.send(response, {
            type: "error",
            code: "ai_output_truncated",
            message: STREAM_MESSAGE.ai_output_truncated,
          });
          controller.abort();
          break;
        }
        streamedChars += event.text.length;
        if (!sawContent && /\S/u.test(event.text)) sawContent = true;
        this.send(response, { type: "delta", text: event.text });
      }

      if (streamError === "ai_output_truncated") {
        // Already reported inside the loop; nothing more to say.
      } else if (cancelled) {
        // Nobody is listening. Skip the frame, keep the metering.
      } else if (!sawContent) {
        streamError = "ai_output_empty";
        this.send(response, {
          type: "error",
          code: "ai_output_empty",
          message: STREAM_MESSAGE.ai_output_empty,
        });
      } else {
        this.send(response, {
          type: "done",
          promptVersion: prompt.promptVersion,
          promptTokens: usage?.promptTokens ?? null,
          completionTokens: usage?.completionTokens ?? null,
        });
      }
    } catch (error) {
      /*
       * An abort we caused surfaces here as a torn stream; it is not a failure
       * to report to a client that has already gone.
       *
       * `streamError === null` matters as much as `!cancelled`. Breaking out of
       * a `for await` calls the iterator's `return()`, and a provider generator
       * cleaning up an aborted `fetch` body can throw from there — which would
       * land here AFTER the truncation branch set `streamError`, overwrite the
       * client's `ai_output_truncated` frame with a misleading
       * `ai_provider_error`, and meter the row as a network fault.
       */
      if (!cancelled && streamError === null) {
        streamError = "ai_provider_error";
        providerCode = error instanceof AiChatProviderError ? error.code : "network";
        this.send(response, {
          type: "error",
          code: "ai_provider_error",
          message: PROVIDER_MESSAGE[providerCode],
        });
      }
    } finally {
      // Computed BEFORE `end()`: ending the response emits `close`, which would
      // otherwise flip `cancelled` and mislabel a completed generation.
      const outcome = this.outcome({
        cancelled,
        streamError,
        providerCode,
        usage,
        streamedChars,
      });
      response.off("close", onClose);
      this.end(response);
      /*
       * A metering failure must not become a thrown request. The response is
       * already ended by this point, so a rejection here would escape `run()`,
       * reach the global exception filter, and have it try to write a JSON
       * envelope onto a finished response — `ERR_HTTP_HEADERS_SENT`, masking
       * the generation that actually succeeded. `recordUsage` already swallows
       * its own database errors; this covers everything else.
       */
      try {
        await grant.recordUsage(outcome);
      } catch {
        // Deliberately swallowed: the log line below still records the outcome.
      }
      this.logger.info(
        {
          workspaceId: input.workspaceId,
          feature: prompt.feature,
          status: outcome.status,
          errorCode: outcome.errorCode ?? undefined,
        },
        "AI generation finished",
      );
    }
  }

  /**
   * One generation, collected into a string.
   *
   * THE PROLOGUE IS `run()`'S, IN THE SAME ORDER, AND FOR THE SAME REASON:
   * authorize, acquire the grant, resolve the provider, and only then talk to
   * anyone. Nothing here is streamed, so there is no "past this line an
   * exception cannot be a JSON envelope" boundary — but the ordering is what
   * keeps a refusal cheap (no provider call) and correct (no grant consumed by a
   * request the authorization layer was going to deny anyway).
   *
   * EXACTLY ONE `ai_usage` ROW, in a `finally`, exactly as `run()` does it. A
   * caller that runs a repair pass therefore produces TWO rows under one feature
   * id, which is the honest description of what it spent.
   */
  async complete(input: AiCompletionInput): Promise<AiCompletion> {
    const { prompt } = input;

    // 1. Note-level tenancy, when the request names a note. `suggestTags` does;
    // `extract` does not, because a pasted transcript belongs to no note yet.
    // The empty-string check is not paranoia about types: an accidental `""`
    // from a caller must not silently skip an authorization step.
    if (typeof input.noteId === "string" && input.noteId.length > 0) {
      await this.authorization.authorizeUser({
        principal: input.principal,
        workspaceId: input.workspaceId,
        action: "note.read",
        resource: { kind: "note", id: input.noteId },
        requestId: input.requestId,
      });
    }

    // 2. The fail-closed governance gate. No `response`, so no `Retry-After` —
    // see the note on `acquire`.
    const grant = await this.acquire({
      workspaceId: input.workspaceId,
      userId: input.principal.userId,
      feature: prompt.feature,
    });

    // 3. Same fail-closed answer as `run()` when the row changed under us.
    const provider = this.providers.resolve(grant.provider);
    if (provider === null) {
      await grant.recordUsage({ status: "failed", errorCode: "ai_not_configured" });
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "AI_NOT_CONFIGURED",
        message: "AI is not configured for this workspace.",
      });
    }

    const controller = new AbortController();
    let text = "";
    let usage: StreamUsage | null = null;
    let streamError: AiStreamErrorCode | null = null;
    let providerCode: AiProviderErrorCode | null = null;

    try {
      for await (const event of provider.stream(
        {
          model: grant.model,
          apiKey: grant.apiKey,
          system: prompt.system,
          messages: prompt.messages,
          maxOutputTokens: prompt.maxOutputTokens,
        },
        controller.signal,
      )) {
        if (event.type === "usage") {
          // The LAST usage event wins: Anthropic splits it across two frames.
          usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
          continue;
        }
        // 4. The server's own ceiling. A JSON document cut off at the limit is
        // not a shorter answer, it is an unparseable one — so this is a failure
        // rather than a truncated success, and the caller never sees half an
        // object it might mistake for a whole one.
        if (text.length + event.text.length > prompt.maxOutputChars) {
          streamError = "ai_output_truncated";
          controller.abort();
          break;
        }
        text += event.text;
      }
    } catch (error) {
      // `streamError === null` guards the same overwrite `run()` guards: a
      // provider generator cleaning up an aborted body can throw from its
      // `return()`, which would land here after the truncation branch already
      // decided what happened.
      if (streamError === null) {
        streamError = "ai_provider_error";
        providerCode = error instanceof AiChatProviderError ? error.code : "network";
      }
    } finally {
      /*
       * Empty output is NOT an error here, deliberately — unlike `run()`, where
       * an empty stream is all the client will ever get. A JSON caller hands the
       * empty string to `json-repair`, which spends the one repair pass it was
       * always allowed and usually gets an answer. Metering it as `success` is
       * accurate: the provider completed, it simply said nothing, and the
       * workspace was charged for the prompt tokens either way.
       */
      const outcome = this.outcome({
        cancelled: false,
        streamError,
        providerCode,
        usage,
        streamedChars: text.length,
      });
      try {
        await grant.recordUsage(outcome);
      } catch {
        // Deliberately swallowed: a metering failure must not become the
        // caller's error. The log line below still records the outcome.
      }
      this.logger.info(
        {
          workspaceId: input.workspaceId,
          feature: prompt.feature,
          status: outcome.status,
          errorCode: outcome.errorCode ?? undefined,
        },
        "AI completion finished",
      );
    }

    if (streamError === "ai_output_truncated") {
      throw new ApiHttpException(HttpStatus.BAD_GATEWAY, {
        code: "AI_PROVIDER_ERROR",
        message: STREAM_MESSAGE.ai_output_truncated,
      });
    }
    if (streamError !== null) {
      // Copy from the CODE, never from a provider response body — the body
      // quotes the request back, and the request is the note or the transcript.
      throw new ApiHttpException(HttpStatus.BAD_GATEWAY, {
        code: "AI_PROVIDER_ERROR",
        message: PROVIDER_MESSAGE[providerCode ?? "network"],
      });
    }

    return {
      text,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
    };
  }

  /**
   * `Retry-After` is set here and nowhere else: `AiGovernanceRefusal` carries
   * `retryAfterMs` for exactly this, and the header must land on the response
   * before the exception filter serialises it. Nothing is written to the body.
   *
   * `response` is OPTIONAL because `complete()` never holds one — Nest owns the
   * response object for an ordinary JSON handler, and reaching for it would mean
   * taking `@Res()` on a route that has no reason to. The consequence is
   * deliberate and worth stating: the two Part 69 JSON routes answer a rate-limit
   * refusal with the correct 429 envelope and `retryAfterMs` inside it, but
   * WITHOUT the `Retry-After` header the three streaming routes carry.
   *
   * ponytail: the ceiling is that a generic HTTP client backing off on the
   * header alone gets no hint on those two routes; every Notted client reads the
   * refusal body. Upgrade path: move the header onto the exception filter, where
   * it belongs for every route at once, rather than threading a `Response` here.
   */
  private async acquire(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly feature: AiPromptFeature;
    readonly response?: Response;
  }): Promise<AiRuntimeGrant> {
    try {
      return await this.governance.acquire({
        workspaceId: input.workspaceId,
        userId: input.userId,
        feature: input.feature,
      });
    } catch (error) {
      if (
        input.response !== undefined &&
        error instanceof AiGovernanceRefusal &&
        error.retryAfterMs !== null
      ) {
        input.response.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1_000)));
      }
      throw error;
    }
  }

  private outcome(state: {
    readonly cancelled: boolean;
    readonly streamError: AiStreamErrorCode | null;
    readonly providerCode: AiProviderErrorCode | null;
    readonly usage: StreamUsage | null;
    readonly streamedChars: number;
  }): AiUsageOutcome {
    if (state.cancelled) {
      return {
        status: "failed",
        errorCode: CLIENT_CANCELLED,
        promptTokens: state.usage?.promptTokens ?? null,
        completionTokens:
          state.usage?.completionTokens ??
          Math.ceil(state.streamedChars / CANCELLED_CHARS_PER_TOKEN),
      };
    }
    const tokens = {
      promptTokens: state.usage?.promptTokens ?? null,
      completionTokens: state.usage?.completionTokens ?? null,
    };
    if (state.streamError !== null) {
      return { status: "failed", errorCode: state.providerCode ?? state.streamError, ...tokens };
    }
    return { status: "success", ...tokens };
  }

  /** Every frame on the wire goes through here, so the framing exists once. */
  private send(response: Response, event: AiStreamEvent): void {
    if (response.writableEnded || response.destroyed) return;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private end(response: Response): void {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}
