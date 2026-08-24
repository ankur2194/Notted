// Part 70 — grammar and style assistance.
//
// THE SAME PIPELINE AS PART 69, WITH ONE EXTRA OBLIGATION. Build a prompt, take
// one non-streamed completion, parse the JSON with at most one repair pass — and
// then re-check every offset the model produced against the text it was given.
// The other JSON features return values a human reads before acting on; this one
// returns COORDINATES, and a coordinate that is off by two silently corrupts a
// sentence when the writer presses Accept.
//
// NOTHING IS PERSISTED, AND NOTHING IS READ. No database dependency at all: the
// request carries its own text, the answer is computed, returned and forgotten
// (ADR 0007 leaves no column it could go in), and a suggestion becomes an edit
// only through an ordinary editor transaction the author starts.
//
// NO `noteId`. A check is posted as a batch of segments, not as a note — the
// browser sends the blocks that changed, and they may belong to a document that
// has not been saved yet. The route's workspace-level `ai.use` authorization is
// therefore the tenancy proof, exactly as it is for `extract()`, and it is
// sufficient because this reads no tenant row.

import { Injectable } from "@nestjs/common";
import { aiGrammarModelSchema } from "@notted/shared-validators";

import { buildGrammarCheckPrompt, buildJsonRepairPrompt } from "./ai-prompts";
import { AiStreamService } from "./ai-stream.service";
import { parseJsonWithRepair } from "./json-repair";

import type {
  AuthenticatedPrincipal,
  GrammarCheckResult,
  GrammarSegment,
  GrammarSuggestion,
} from "@notted/shared-types";

@Injectable()
export class GrammarService {
  constructor(private readonly stream: AiStreamService) {}

  async check(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly workspaceId: string;
    readonly requestId: string | null;
    readonly segments: readonly GrammarSegment[];
  }): Promise<GrammarCheckResult> {
    const plan = buildGrammarCheckPrompt({ segments: input.segments });
    const completion = await this.stream.complete({
      principal: input.principal,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      prompt: plan,
    });

    const model = await parseJsonWithRepair({
      raw: completion.text,
      schema: aiGrammarModelSchema,
      // The one repair pass: a SECOND `complete()`, so it is authorized, gated
      // and metered exactly like the first, under the same feature id. There is
      // no third — the helper has no loop.
      repair: async (issue, previousOutput) => {
        const retry = await this.stream.complete({
          principal: input.principal,
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          prompt: buildJsonRepairPrompt(plan, previousOutput, issue),
        });
        return retry.text;
      },
    });

    // The segment map is built from the REQUEST, never from the reply: a
    // `segmentId` the caller did not send addresses nothing this server knows
    // about, so it cannot be answered.
    const byId = new Map(input.segments.map((segment) => [segment.id, segment.text]));

    const suggestions: GrammarSuggestion[] = [];
    for (const candidate of model.suggestions) {
      const text = byId.get(candidate.segmentId);
      if (text === undefined) continue;
      // `0 <= start < end <= text.length`. The schema pins the lower bound at 0
      // and nothing else — it cannot, because it does not know how long the
      // segment was. An inverted or empty range describes no text, and a range
      // past the end describes text that was never sent.
      if (candidate.start >= candidate.end || candidate.end > text.length) continue;
      // A "correction" that replaces a span with itself. Harmless to apply and
      // pointless to draw, so it never reaches the writer as an underline.
      if (text.slice(candidate.start, candidate.end) === candidate.replacement) continue;
      suggestions.push(candidate);
    }

    // DROPPED SILENTLY: no log line, no error, no partial-failure flag. Not
    // logged because a suggestion is note content and ADR 0007 keeps that out of
    // logs. Not an error because the browser re-validates every suggestion
    // against the LIVE document before it can touch anything — a dropped one
    // therefore costs nothing, while failing the request would throw away an
    // otherwise useful answer over one bad offset.
    //
    // No explicit cap: `aiGrammarModelSchema` already slices to
    // AI_GRAMMAR_SUGGESTION_MAX and this loop only ever drops, so the survivors
    // cannot exceed it.
    return { suggestions };
  }
}
