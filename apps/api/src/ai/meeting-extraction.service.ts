// Part 69 — meeting extraction and tag suggestion.
//
// TWO FEATURES, ONE SERVICE, BECAUSE THEY ARE THE SAME SHAPE. Build a prompt,
// take one non-streamed completion, parse the JSON with at most one repair
// pass, and return a plain value. Splitting them would duplicate that pipeline
// and give a future reader two places to look for "how does a JSON AI feature
// work here".
//
// NOTHING IS PERSISTED. An extraction is computed, returned, and forgotten; a
// tag suggestion assigns nothing. The transcript never reaches a column (there
// is none it could go in — ADR 0007), the note document is only ever changed by
// an editor transaction the author starts from the review screen, and a tag is
// only ever created or attached by an explicit "Apply" on an existing route.
//
// THE MODEL NEVER SEES A TAG ID, AND NEVER SUPPLIES ONE. It is shown the
// workspace's tag NAMES and answers with names. `partition` then matches those
// names, case-insensitively, against the pool this server read under an explicit
// `workspace_id` predicate — so "an `existing` suggestion is always a real tag
// of this workspace" is a property of the matching code, not of the prompt. A
// hallucinated name cannot become an id; it becomes a `proposed` entry the user
// must accept before anything is created.

import { Injectable } from "@nestjs/common";
import {
  aiMeetingExtractionSchema,
  aiTagSuggestionModelSchema,
  AI_TAG_SUGGESTION_EXISTING_MAX,
  AI_TAG_SUGGESTION_PROPOSED_MAX,
  tagNameSchema,
} from "@notted/shared-validators";
import { eq } from "drizzle-orm";

import { DatabaseService } from "../database/database.service";
import { tags } from "../database/schema";
import { TAG_MAX_PER_WORKSPACE } from "../tags/tags.constants";

import {
  buildJsonRepairPrompt,
  buildMeetingExtractionPrompt,
  buildTagSuggestionPrompt,
} from "./ai-prompts";
import { AiStreamService } from "./ai-stream.service";
import { parseJsonWithRepair } from "./json-repair";

import type { AiPromptPlan } from "./ai-prompts";
import type {
  AuthenticatedPrincipal,
  MeetingExtractionResult,
  TagSuggestionExistingTag,
  TagSuggestionProposedTag,
  TagSuggestionResult,
} from "@notted/shared-types";

interface AiRequestScope {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId: string | null;
}

interface WorkspaceTag {
  readonly id: string;
  readonly name: string;
}

@Injectable()
export class MeetingExtractionService {
  constructor(
    private readonly stream: AiStreamService,
    private readonly database: DatabaseService,
  ) {}

  /**
   * No `noteId`: a transcript is pasted, not read out of a note, so there is no
   * note to authorize against. The route's `ai.use` workspace authorization is
   * the tenancy proof, and it is enough — this reads no tenant row at all.
   */
  async extract(
    input: AiRequestScope & { readonly transcript: string },
  ): Promise<MeetingExtractionResult> {
    const plan = buildMeetingExtractionPrompt({ transcript: input.transcript });
    const completion = await this.stream.complete({
      principal: input.principal,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      prompt: plan,
    });

    const extraction = await parseJsonWithRepair({
      raw: completion.text,
      schema: aiMeetingExtractionSchema,
      repair: this.repair(input, plan),
    });

    // The schema has already applied every per-item bound and list cap; wrapping
    // it here is the whole of the response contract.
    return { extraction };
  }

  /**
   * `noteId` IS passed here, and that is the tenancy proof: `complete()`
   * authorizes `note.read` on it, which fails closed for a note in another
   * workspace before a single provider token is spent.
   */
  async suggestTags(
    input: AiRequestScope & { readonly noteId: string; readonly content: string },
  ): Promise<TagSuggestionResult> {
    const pool = await this.loadTagPool(input.workspaceId);
    const plan = buildTagSuggestionPrompt({
      content: input.content,
      pool: pool.map((tag) => tag.name),
    });

    const completion = await this.stream.complete({
      principal: input.principal,
      workspaceId: input.workspaceId,
      noteId: input.noteId,
      requestId: input.requestId,
      prompt: plan,
    });

    const model = await parseJsonWithRepair({
      raw: completion.text,
      schema: aiTagSuggestionModelSchema,
      repair: this.repair(input, plan),
    });

    return partition(model.tags, pool);
  }

  /**
   * The one repair pass, expressed as the callback `json-repair` calls at most
   * once. It is a SECOND `complete()` — so it is authorized, gated and metered
   * exactly like the first, under the same feature id — and there is no third:
   * the helper has no loop.
   */
  private repair(
    scope: AiRequestScope & { readonly noteId?: string },
    plan: AiPromptPlan,
  ): (issue: string, previousOutput: string) => Promise<string> {
    return async (issue, previousOutput) => {
      const retry = await this.stream.complete({
        principal: scope.principal,
        workspaceId: scope.workspaceId,
        noteId: scope.noteId ?? null,
        requestId: scope.requestId,
        prompt: buildJsonRepairPrompt(plan, previousOutput, issue),
      });
      return retry.text;
    };
  }

  /**
   * Two columns of one workspace's tags, read directly rather than through
   * `TagsService`.
   *
   * ponytail: a module edge onto `TagsModule` for a two-column read is graph
   * coupling that buys nothing — the list route's pagination, sorting and usage
   * counts are all things this caller would immediately throw away. The tenancy
   * rule is not skipped, it is restated: `eq(tags.workspaceId, …)` is explicit
   * and mandatory here, exactly as `ai-governance.service.ts` pins
   * `ai_provider_config.workspace_id`. Upgrade path: if a second AI feature ever
   * needs the tag vocabulary, promote this to a shared read on `TagsService`.
   *
   * `TAG_MAX_PER_WORKSPACE` is the natural limit because it is the cap the
   * create transaction already enforces: the pool cannot legitimately be larger.
   */
  private async loadTagPool(workspaceId: string): Promise<readonly WorkspaceTag[]> {
    return await this.database.db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.workspaceId, workspaceId))
      .limit(TAG_MAX_PER_WORKSPACE);
  }
}

/**
 * Collapse whitespace and trim. A model writes `" Product  Launch"` and means
 * the workspace's `"Product Launch"`; matching on the raw string would file that
 * as a brand-new tag and quietly grow a duplicate vocabulary.
 */
function normalize(name: string): string {
  return name.trim().replace(/\s+/gu, " ");
}

/**
 * Split model-proposed NAMES into existing tags (with their real ids) and new
 * ones. Every rule here is a safety rule, not a formatting one — see the file
 * header on why the id can only ever come from the pool.
 */
function partition(names: readonly string[], pool: readonly WorkspaceTag[]): TagSuggestionResult {
  const byLowerName = new Map<string, WorkspaceTag>();
  for (const tag of pool) {
    const key = normalize(tag.name).toLowerCase();
    // First spelling wins; the `(workspace_id, name)` unique index makes an
    // exact collision impossible, but two case variants are not excluded by it.
    if (!byLowerName.has(key)) byLowerName.set(key, tag);
  }

  const existing: TagSuggestionExistingTag[] = [];
  const proposed: TagSuggestionProposedTag[] = [];
  const seenTagIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const raw of names) {
    const name = normalize(raw);
    if (name === "") continue;
    const key = name.toLowerCase();

    const match = byLowerName.get(key);
    if (match !== undefined) {
      // A name that exists must never be offered as new, even once `existing` is
      // full: accepting it would create a duplicate of a tag already in the
      // workspace.
      if (seenTagIds.has(match.id) || existing.length >= AI_TAG_SUGGESTION_EXISTING_MAX) continue;
      seenTagIds.add(match.id);
      seenNames.add(normalize(match.name).toLowerCase());
      // The POOL's spelling, not the model's: this is the tag the workspace has.
      existing.push({ tagId: match.id, name: match.name });
      continue;
    }

    if (seenNames.has(key)) continue;
    // `tagNameSchema` is the same 50-character bound `tags.name` is declared
    // with, so anything it rejects could not be created anyway.
    if (!tagNameSchema.safeParse(name).success) continue;
    if (proposed.length >= AI_TAG_SUGGESTION_PROPOSED_MAX) continue;
    seenNames.add(key);
    proposed.push({ name });
  }

  return { existing, proposed };
}
