"use client";

import { AI_TAG_CONTENT_MAX_CHARS } from "@notted/shared-validators";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Tags } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRequestFailure, ApiRequestFailureKind } from "@/lib/api/request-json";
import type { TagSuggestionResult } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";

import { Button } from "@/components/ui/button";
import { aiQueryKeys } from "@/lib/ai/query-keys";
import { fetchAiStatus, requestTagSuggestions } from "@/lib/ai/requests";
import { AI_FAILURE_MESSAGES } from "@/lib/ai/stream";
import { requestNoteDetail, updateNote } from "@/lib/notes/requests";
import { createTag, requestTagPage } from "@/lib/tags/requests";

/**
 * Part 69 — AI tag suggestions.
 *
 * ## THE INVARIANT
 *
 * **Nothing is created and nothing is assigned until Apply is pressed.** Asking
 * for suggestions is a read: it produces chips, and chips are a proposal. No tag
 * row is created, no `note_tags` edge is written, and `updateNote` is not called
 * until the author has confirmed a selection — because a model that invented
 * "Q3-planning" would otherwise permanently pollute a shared workspace taxonomy
 * that every member sees in the tag filter, and undoing that is manual work.
 * Nothing is selected by default for the same reason.
 *
 * ## Why the two groups are structural
 *
 * "Reuse this tag you already have" and "create a tag that does not exist yet"
 * are different decisions with different consequences, so they are different
 * groups with their own headings — not one list with a coloured hint. The
 * proposed group is additionally dashed, but the *heading* is what carries the
 * meaning: colour alone would fail WCAG 1.4.1 and a dashed border alone is not
 * announced at all.
 *
 * ## Why Apply re-reads the note
 *
 * See {@link applySelection}. In short: the version this component could have
 * captured at suggest time is stale before the user has finished reading the
 * chips.
 */

export interface TagSuggestionsProps {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly editor: Editor | null;
  /** False for a viewer or a trashed note: this renders nothing at all. */
  readonly editable: boolean;
}

const HEADING_ID = "note-tag-suggestions-heading";
const EXISTING_GROUP_ID = "note-tag-suggestions-existing";
const PROPOSED_GROUP_ID = "note-tag-suggestions-proposed";

/**
 * `tagIdsSchema` caps a note at 50 tags. Duplicated as a number rather than
 * imported because the schema exposes the bound only through `.max(50)`; the
 * point of checking it here is to refuse with copy instead of sending a body the
 * shared contract will reject with a bare "invalid".
 */
const NOTE_TAG_LIMIT = 50;

const STATUS_UNAVAILABLE_MESSAGE = "AI is unavailable right now. Try again in a moment.";
const NO_EDITOR_MESSAGE = "The note is still loading. Try again in a moment.";
const EMPTY_NOTE_MESSAGE = "There is nothing to tag yet. Write something first.";
const SUGGESTING_MESSAGE = "Looking for tags…";
const NO_SUGGESTIONS_MESSAGE = "No tags were suggested for this note.";
const NOTHING_SELECTED_MESSAGE = "Choose at least one tag first. Nothing has been changed.";
const APPLYING_MESSAGE = "Applying tags…";
const TAG_LIMIT_MESSAGE = `A note can carry at most ${NOTE_TAG_LIMIT} tags. Choose fewer, or remove some of the note's current tags first.`;
const VERSION_CONFLICT_MESSAGE =
  "The note changed while the tags were being applied, so nothing was written. Press Apply again to retry with the note's current state.";

const FAILURE_MESSAGES: Readonly<Record<ApiRequestFailureKind, string>> = Object.freeze({
  invalid: "That request was rejected. Nothing was changed.",
  "forbidden-or-not-found": "You do not have permission to change tags on this note.",
  conflict: "That tag could not be reused. Nothing was changed.",
  "version-conflict": VERSION_CONFLICT_MESSAGE,
  unavailable: "Tagging is unavailable right now. Nothing was changed.",
});

/**
 * Copy chosen by the envelope's stable code where the code changes what the
 * reader must do. The governance sentences are the same ones the AI panel and
 * the server use, so a refusal reads identically wherever it surfaces.
 */
const CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AI_DISABLED: AI_FAILURE_MESSAGES.AI_DISABLED,
  AI_NOT_CONFIGURED: AI_FAILURE_MESSAGES.AI_NOT_CONFIGURED,
  AI_CONSENT_REQUIRED: AI_FAILURE_MESSAGES.AI_CONSENT_REQUIRED,
  AI_QUOTA_EXCEEDED: AI_FAILURE_MESSAGES.AI_QUOTA_EXCEEDED,
  AI_RATE_LIMITED: AI_FAILURE_MESSAGES.AI_RATE_LIMITED,
  AI_OUTPUT_INVALID:
    "The AI answered with something this app could not read as tags. Nothing was changed — try again.",
  AI_PROVIDER_ERROR: "The AI provider could not be reached. Nothing was changed — try again.",
});

function failureMessage(failure: ApiRequestFailure): string {
  // `Object.hasOwn`, never `in`: the code comes from a body this client did not
  // write, and `in` would walk the prototype chain and hand back `Object`'s
  // `constructor` for `code: "constructor"`.
  const byCode =
    failure.code !== undefined && Object.hasOwn(CODE_MESSAGES, failure.code)
      ? CODE_MESSAGES[failure.code]
      : undefined;
  return byCode ?? FAILURE_MESSAGES[failure.kind];
}

function toggle(current: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(current);
  if (!next.delete(value)) next.add(value);
  return next;
}

const CHIP_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-full border border-input bg-background px-3 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-foreground";

export function TagSuggestions({ workspaceId, noteId, editor, editable }: TagSuggestionsProps) {
  const [result, setResult] = useState<TagSuggestionResult | null>(null);
  const [selectedExisting, setSelectedExisting] = useState<ReadonlySet<string>>(new Set());
  const [selectedProposed, setSelectedProposed] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "suggesting" | "applying">("idle");
  const [message, setMessage] = useState("");

  const abortRef = useRef<AbortController | null>(null);

  /*
   * The same query key as the AI panel, deliberately: both surfaces need the
   * identical member-readable projection, and sharing the key means the second
   * one to mount costs no request at all.
   */
  const status = useQuery({
    queryKey: aiQueryKeys.status(workspaceId),
    queryFn: async () => {
      const outcome = await fetchAiStatus(workspaceId);
      // A failed read must not collapse to "AI is off": that is a different
      // situation with different copy and a different remedy.
      if (!outcome.ok) throw new Error(`ai status unavailable: ${outcome.kind}`);
      return outcome.data;
    },
    enabled: editable,
    staleTime: 5 * 60_000,
  });

  const enabled = status.data?.enabled === true;
  const configured = status.data !== undefined && status.data.provider !== "disabled";

  const unavailableReason: string | null = status.isPending
    ? null
    : status.isError
      ? STATUS_UNAVAILABLE_MESSAGE
      : !enabled
        ? AI_FAILURE_MESSAGES.AI_DISABLED
        : !configured
          ? AI_FAILURE_MESSAGES.AI_NOT_CONFIGURED
          : null;
  const canSuggest = !status.isPending && unavailableReason === null;

  // An in-flight suggestion outlives nothing: a response landing after unmount
  // would set state on a dead component and bill a request nobody can see.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const suggest = useCallback(async (): Promise<void> => {
    if (editor === null) {
      setMessage(NO_EDITOR_MESSAGE);
      return;
    }
    /*
     * `textBetween(…, "\n\n", " ")`, not `doc.textContent`: the latter joins
     * blocks with NOTHING, so a three-paragraph note would reach the model as
     * one run-on string and every heading boundary a tag might come from is gone.
     */
    const content = editor.state.doc
      .textBetween(0, editor.state.doc.content.size, "\n\n", " ")
      .slice(0, AI_TAG_CONTENT_MAX_CHARS);
    // The shared schema trims and requires at least one character, so an empty
    // note would spend a provider call to be told what is knowable here.
    if (content.trim().length === 0) {
      setMessage(EMPTY_NOTE_MESSAGE);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("suggesting");
    setResult(null);
    setSelectedExisting(new Set());
    setSelectedProposed(new Set());
    setMessage(SUGGESTING_MESSAGE);

    const outcome = await requestTagSuggestions(
      workspaceId,
      { noteId, content },
      { signal: controller.signal },
    );
    // A superseded or unmounted request must not write state, whether the
    // transport reported the abort as a failure or resolved just after it.
    if (controller.signal.aborted) return;
    abortRef.current = null;
    setPhase("idle");

    if (!outcome.ok) {
      setMessage(failureMessage(outcome));
      return;
    }
    setResult(outcome.data);
    const count = outcome.data.existing.length + outcome.data.proposed.length;
    setMessage(
      count === 0
        ? NO_SUGGESTIONS_MESSAGE
        : `${count} tag${count === 1 ? "" : "s"} suggested. Choose the ones you want, then press Apply. Nothing has been changed yet.`,
    );
  }, [editor, noteId, workspaceId]);

  const applySelection = useCallback(async (): Promise<void> => {
    if (result === null || phase === "applying") return;
    const existing = result.existing.filter((tag) => selectedExisting.has(tag.tagId));
    const proposed = result.proposed.filter((tag) => selectedProposed.has(tag.name));
    if (existing.length + proposed.length === 0) {
      setMessage(NOTHING_SELECTED_MESSAGE);
      return;
    }

    setPhase("applying");
    setMessage(APPLYING_MESSAGE);

    const confirmedIds: string[] = existing.map((tag) => tag.tagId);
    const failedNames: string[] = [];
    let createdCount = 0;

    /*
     * Sequentially, one name at a time, because a 409 has to be handled for that
     * name before the next one is attempted — and because creating five tags in
     * parallel makes the failure report ambiguous about which of them landed.
     */
    for (const { name } of proposed) {
      const created = await createTag(workspaceId, { name }, globalThis.crypto.randomUUID());
      if (created.ok) {
        confirmedIds.push(created.data.tag.id);
        createdCount += 1;
        continue;
      }
      if (created.kind !== "conflict" && created.code !== "TAG_NAME_TAKEN") {
        failedNames.push(name);
        continue;
      }
      /*
       * `TAG_NAME_TAKEN`: someone already made this tag — possibly this very
       * Apply on an earlier attempt. The tag is looked up and REUSED rather than
       * re-created, so a retry after a version conflict converges instead of
       * failing forever. `TAG_LIMIT_REACHED` is also a 409 and lands here too;
       * it simply finds nothing and is reported as a failed name, which is the
       * correct outcome without a branch of its own.
       */
      const page = await requestTagPage(workspaceId, {
        page: 1,
        limit: 50,
        name,
        sortBy: "name",
        sortDirection: "asc",
      });
      const match = page.ok
        ? // The server matches names case-insensitively, so the filter can return
          // a differently-cased row than the one asked for.
          page.data.items.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
        : undefined;
      if (match === undefined) {
        failedNames.push(name);
        continue;
      }
      confirmedIds.push(match.id);
    }

    /*
     * THE NOTE IS RE-READ HERE, deliberately, immediately before the write.
     *
     * Part 39 autosave bumps `notes.version` every time the author types, so any
     * version this component had captured — at mount, or when the suggestions
     * came back — is already stale by the time somebody has read five chips and
     * pressed a button. Sending that version would lose the `expectedVersion`
     * CAS on a note whose only "conflict" is that its own author is editing it.
     * Reading the current state one request before the PATCH is what makes Apply
     * survive an actively edited note; it also supplies the note's CURRENT tags,
     * which is what the union below is built on.
     */
    const detail = await requestNoteDetail(workspaceId, noteId);
    if (!detail.ok) {
      setPhase("idle");
      setMessage(failureMessage(detail));
      return;
    }

    // The note's own tags first and in their existing order — this is a full
    // replace, so anything dropped here would be silently UNASSIGNED.
    const tagIds = [...detail.data.tagIds];
    for (const id of confirmedIds) if (!tagIds.includes(id)) tagIds.push(id);

    if (tagIds.length > NOTE_TAG_LIMIT) {
      setPhase("idle");
      setMessage(TAG_LIMIT_MESSAGE);
      return;
    }

    const attached = tagIds.length - detail.data.tagIds.length;
    const updated = await updateNote(workspaceId, noteId, {
      expectedVersion: detail.data.version,
      tagIds,
    });
    setPhase("idle");

    if (!updated.ok) {
      setMessage(failureMessage(updated));
      return;
    }

    const parts = [`${attached} tag${attached === 1 ? "" : "s"} added to this note`];
    if (createdCount > 0) parts.push(`${createdCount} newly created`);
    if (failedNames.length > 0) parts.push(`${failedNames.join(", ")} could not be added`);
    setMessage(`${parts.join(", ")}.`);

    if (failedNames.length === 0) {
      // Applied in full: the proposal is spent. A partial failure keeps the
      // chips so the reader can retry the names that did not land.
      setResult(null);
      setSelectedExisting(new Set());
      setSelectedProposed(new Set());
    }
  }, [noteId, phase, result, selectedExisting, selectedProposed, workspaceId]);

  // Hooks above run unconditionally; the render decision comes after them.
  if (!editable) return null;

  const busy = phase !== "idle";

  return (
    <section
      aria-labelledby={HEADING_ID}
      className="space-y-3 rounded-xl border bg-card p-4"
      data-notted-print-hide
      data-testid="note-tag-suggestions"
    >
      <h2 id={HEADING_ID} className="text-lg font-semibold">
        Suggested tags
      </h2>
      <p className="text-xs text-muted-foreground">
        Suggestions are a proposal. No tag is created or added to this note until you press Apply.
      </p>

      {/* The one polite region: outcomes only, and the sighted reader's copy too. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm"
        data-testid="note-tag-suggestions-status"
      >
        {message}
      </p>

      {unavailableReason !== null ? (
        <p className="text-sm text-muted-foreground" data-testid="note-tag-suggestions-unavailable">
          {unavailableReason}
          {status.isError ? (
            <Button
              className="ml-2"
              size="sm"
              variant="outline"
              onClick={() => void status.refetch()}
            >
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}

      {canSuggest ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="ai-suggest-tags"
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              // `aria-disabled` never makes a control inert; the handler refuses
              // while keeping the button in the tab order.
              if (busy) return;
              void suggest();
            }}
          >
            <Tags aria-hidden="true" /> Suggest tags
          </Button>
          {busy ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {phase === "applying" ? APPLYING_MESSAGE : SUGGESTING_MESSAGE}
            </span>
          ) : null}
        </div>
      ) : null}

      {result !== null && result.existing.length > 0 ? (
        <div
          role="group"
          aria-labelledby={EXISTING_GROUP_ID}
          className="space-y-2 border-t pt-3"
          data-testid="note-tag-suggestions-existing"
        >
          <h3 id={EXISTING_GROUP_ID} className="text-sm font-semibold">
            Existing tags
          </h3>
          <div className="flex flex-wrap gap-2">
            {result.existing.map((tag) => (
              <button
                key={tag.tagId}
                type="button"
                aria-pressed={selectedExisting.has(tag.tagId)}
                className={CHIP_CLASS}
                onClick={() => setSelectedExisting((current) => toggle(current, tag.tagId))}
              >
                {tag.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {result !== null && result.proposed.length > 0 ? (
        <div
          role="group"
          aria-labelledby={PROPOSED_GROUP_ID}
          className="space-y-2 border-t pt-3"
          data-testid="note-tag-suggestions-proposed"
        >
          {/*
           * The heading is what says these tags do not exist yet. The dashed
           * border repeats it visually; neither the border nor any colour is
           * ever the only carrier of that distinction.
           */}
          <h3 id={PROPOSED_GROUP_ID} className="text-sm font-semibold">
            New tags (will be created)
          </h3>
          <div className="flex flex-wrap gap-2">
            {result.proposed.map((tag) => (
              <button
                key={tag.name}
                type="button"
                aria-pressed={selectedProposed.has(tag.name)}
                className={`${CHIP_CLASS} border-dashed`}
                onClick={() => setSelectedProposed((current) => toggle(current, tag.name))}
              >
                {tag.name}
                <span className="sr-only"> (new tag, will be created)</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {result !== null && result.existing.length + result.proposed.length > 0 ? (
        <div className="border-t pt-3">
          <Button
            size="sm"
            data-testid="ai-apply-tags"
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (busy) return;
              void applySelection();
            }}
          >
            Apply
          </Button>
        </div>
      ) : null}
    </section>
  );
}
