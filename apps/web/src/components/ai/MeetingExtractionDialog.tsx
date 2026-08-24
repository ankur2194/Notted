"use client";

import { AI_MEETING_TRANSCRIPT_MAX_CHARS } from "@notted/shared-validators";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRequestFailure, ApiRequestFailureKind } from "@/lib/api/request-json";
import type { MeetingActionItem, MeetingExtraction } from "@notted/shared-types";
import type { Editor, JSONContent } from "@tiptap/core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { blockInsertPos } from "@/lib/ai/insert-position";
import { setMeetingExtractionHandler } from "@/lib/ai/meeting-extraction-request";
import { aiQueryKeys } from "@/lib/ai/query-keys";
import { fetchAiStatus, requestMeetingExtraction } from "@/lib/ai/requests";
import { AI_FAILURE_MESSAGES } from "@/lib/ai/stream";
import { composeDueDate } from "@/lib/tasks/grouping";
import { createTask, requestTaskPage } from "@/lib/tasks/requests";

/**
 * Part 69 — paste a transcript, review what a model found in it, and insert
 * only the parts the author confirmed.
 *
 * ## THE INVARIANT
 *
 * **Nothing is written before Insert.** The review step performs no editor
 * transaction and issues no task request at any point; it is a form over a
 * proposal. That is the whole safeguard — a model reading a two-hour transcript
 * will attribute a decision to the wrong person eventually, and the only place
 * that can be caught is between the extraction and the write.
 *
 * ## No visible trigger of its own
 *
 * The dialog registers an open handler on `lib/ai/meeting-extraction-request`
 * and is opened from the AI panel button and the `/meeting` slash command,
 * neither of which is an ancestor of this component. Registration happens ONLY
 * while the command can actually be served, so `isMeetingExtractionAvailable()`
 * is also the honest answer to "should the slash menu offer it".
 *
 * ## It never streams
 *
 * Unlike Part 68's three features the response is one structured object, so it
 * goes through `requestJson` and not `lib/ai/stream`. There is nothing useful to
 * show a reader halfway through a half-parsed extraction.
 */

export interface MeetingExtractionDialogProps {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly editor: Editor | null;
  /** False for a viewer or a trashed note: the command is never registered. */
  readonly editable: boolean;
}

/* -------------------------------------------------------------------------- *
 * Copy
 * -------------------------------------------------------------------------- */

const STATUS_UNAVAILABLE_MESSAGE = "AI is unavailable right now. Try again in a moment.";
const NO_EDITOR_MESSAGE = "The note is still loading. Try again in a moment.";
const EMPTY_TRANSCRIPT_MESSAGE = "Paste the meeting transcript first.";
const TRANSCRIPT_TOO_LONG_MESSAGE = `That transcript is too long. Paste at most ${AI_MEETING_TRANSCRIPT_MAX_CHARS.toLocaleString()} characters.`;
const NOTHING_SELECTED_MESSAGE = "Nothing is selected, so there is nothing to insert.";
const EXTRACTING_MESSAGE = "Reading the transcript. This can take a minute for a long meeting.";
const REVIEW_READY_MESSAGE = "Extraction ready for review. Nothing has been added to the note yet.";
const INSERTED_MESSAGE = "Meeting notes inserted into the note.";

/** Every failure kind, so a new one can never fall through to a blank message. */
const FAILURE_MESSAGES: Readonly<Record<ApiRequestFailureKind, string>> = Object.freeze({
  invalid: "That transcript was rejected. Check its length and try again.",
  "forbidden-or-not-found": "You do not have permission to use AI on this note.",
  conflict: "That request could not be completed. Try again.",
  "version-conflict": "That request could not be completed. Try again.",
  unavailable: STATUS_UNAVAILABLE_MESSAGE,
});

/**
 * Stable envelope codes that mean something more specific than their status.
 *
 * The governance copy is the same copy the streaming features use, so a refusal
 * reads identically whichever AI surface produced it. The two Part 69 codes are
 * new: `AI_OUTPUT_INVALID` is the model answering off-contract (retrying is
 * genuinely worth a try), `AI_PROVIDER_ERROR` is the provider itself failing.
 */
const CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AI_DISABLED: AI_FAILURE_MESSAGES.AI_DISABLED,
  AI_NOT_CONFIGURED: AI_FAILURE_MESSAGES.AI_NOT_CONFIGURED,
  AI_CONSENT_REQUIRED: AI_FAILURE_MESSAGES.AI_CONSENT_REQUIRED,
  AI_QUOTA_EXCEEDED: AI_FAILURE_MESSAGES.AI_QUOTA_EXCEEDED,
  AI_RATE_LIMITED: AI_FAILURE_MESSAGES.AI_RATE_LIMITED,
  AI_OUTPUT_INVALID:
    "The AI answered with something Notted could not read as a meeting summary. Extracting again usually fixes it.",
  AI_PROVIDER_ERROR:
    "The AI provider could not complete this request. Wait a moment and try again.",
});

/**
 * `Object.hasOwn`, never `in`: `in` walks the prototype chain, so an envelope
 * carrying `code: "constructor"` would pass the guard and hand React a function
 * typed here as `string`. Same trust-boundary reasoning as `lib/ai/stream.ts`.
 */
function failureMessage(failure: ApiRequestFailure): string {
  const code = failure.code;
  if (code !== undefined && Object.hasOwn(CODE_MESSAGES, code)) {
    const message = CODE_MESSAGES[code];
    if (message !== undefined) return message;
  }
  return FAILURE_MESSAGES[failure.kind];
}

/* -------------------------------------------------------------------------- *
 * Review model
 * -------------------------------------------------------------------------- */

const PLAIN_SECTIONS = Object.freeze([
  { key: "attendees", heading: "Attendees" },
  { key: "agenda", heading: "Agenda" },
  { key: "discussionPoints", heading: "Discussion points" },
  { key: "decisions", heading: "Decisions" },
] as const);

type PlainSectionKey = (typeof PLAIN_SECTIONS)[number]["key"];

interface ReviewItem {
  readonly text: string;
  readonly include: boolean;
}

interface ReviewActionItem extends ReviewItem {
  readonly assignee?: string;
  readonly dueDate?: string;
  /** Default OFF: a note line and a tracked task are different commitments. */
  readonly createTask: boolean;
  /** A workspace task already carries this title, normalised. */
  readonly duplicate: boolean;
}

interface ReviewSection {
  readonly key: PlainSectionKey;
  readonly heading: string;
  readonly items: readonly ReviewItem[];
}

interface Review {
  /** An ordered list rather than a keyed record so an update needs no computed key. */
  readonly sections: readonly ReviewSection[];
  readonly actionItems: readonly ReviewActionItem[];
}

/** Trim, lowercase, collapse runs of whitespace. "Ship  the Draft " ≡ "ship the draft". */
function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function buildReview(extraction: MeetingExtraction, existingTitles: ReadonlySet<string>): Review {
  return {
    sections: PLAIN_SECTIONS.map((section) => ({
      key: section.key,
      heading: section.heading,
      // Everything the model found starts CHECKED: the reviewer's job is to
      // remove what is wrong, which is a far shorter list than what is right.
      items: extraction[section.key].map((text) => ({ text, include: true })),
    })),
    actionItems: extraction.actionItems.map((item) => ({
      text: item.text,
      include: true,
      ...(item.assignee === undefined ? {} : { assignee: item.assignee }),
      ...(item.dueDate === undefined ? {} : { dueDate: item.dueDate }),
      createTask: false,
      duplicate: existingTitles.has(normalizeTitle(item.text)),
    })),
  };
}

function patchAt<T extends object>(items: readonly T[], index: number, patch: Partial<T>): T[] {
  return items.map((item, position) => (position === index ? { ...item, ...patch } : item));
}

/**
 * The item as one readable line.
 *
 * The assignee and the due date are appended to the TEXT rather than added as
 * extra nodes: a `taskItem` holds one paragraph, and inventing a nested
 * structure for two optional strings would be a document shape nothing else in
 * Notted produces and the reader has to decode.
 */
function actionItemText(
  item: Pick<MeetingActionItem, "assignee" | "dueDate"> & { readonly text: string },
): string {
  const suffix = [
    item.assignee,
    item.dueDate === undefined ? undefined : `due ${item.dueDate}`,
  ].filter((part): part is string => part !== undefined);
  const text = item.text.trim();
  return suffix.length === 0 ? text : `${text} — ${suffix.join(" · ")}`;
}

function textParagraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

/**
 * The confirmed review as ProseMirror JSON.
 *
 * NEVER HAND MODEL OUTPUT TO TIPTAP AS A STRING. `insertContentAt` routes a
 * string through `DOMParser.parseSlice`, which is HTML parsing: `if (x < y)`
 * loses its tail, `<sam@example.com>` vanishes entirely, and a transcript
 * carrying `<img src=…>` — pasted from anywhere, quoted back by the model —
 * becomes a live node via the image and safe-link extensions. A prompt is not a
 * control. Building JSON means the text is inserted as text, whatever the model
 * was talked into saying.
 *
 * Every node and attribute below is one `safeParseNoteDocument` accepts:
 * `heading` (level 1-6), `bulletList` → `listItem` → `paragraph`, and
 * `taskList` → `taskItem` (whose `checked` attribute is REQUIRED and must be a
 * boolean) → `paragraph`. A node the contract rejects halts autosave, so this
 * is checked against `packages/shared-validators/src/document.schema.ts` rather
 * than assumed.
 */
function meetingNodes(review: Review): JSONContent[] {
  const nodes: JSONContent[] = [];
  for (const section of review.sections) {
    const texts = section.items
      .filter((item) => item.include)
      .map((item) => item.text.trim())
      .filter((text) => text.length > 0);
    // An empty or fully unchecked section contributes nothing — not even its
    // heading, which would otherwise read as "no attendees were recorded".
    if (texts.length === 0) continue;
    nodes.push(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: section.heading }] },
      {
        type: "bulletList",
        content: texts.map((text) => ({ type: "listItem", content: [textParagraph(text)] })),
      },
    );
  }
  const actions = review.actionItems
    .filter((item) => item.include)
    .map((item) => actionItemText(item))
    .filter((text) => text.length > 0);
  if (actions.length > 0) {
    nodes.push(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Action items" }] },
      {
        type: "taskList",
        // Unchecked: an action item agreed in a meeting is work still to do.
        content: actions.map((text) => ({
          type: "taskItem",
          attrs: { checked: false },
          content: [textParagraph(text)],
        })),
      },
    );
  }
  return nodes;
}

/* -------------------------------------------------------------------------- *
 * Duplicate-task guard
 * -------------------------------------------------------------------------- */

/**
 * How many existing tasks the duplicate badge is allowed to scan.
 *
 * ONE bounded page, newest first. A workspace with more than this can hold a
 * duplicate the badge misses, and that is accepted deliberately: the badge is an
 * aid for the reviewer, not a constraint, and paging the whole task table to
 * render five checkboxes would make the review step wait on a workspace's entire
 * history. Nothing depends on it being exhaustive — the box is unchecked by
 * default either way.
 */
const EXISTING_TASK_SCAN_LIMIT = 100;

async function existingTaskTitles(workspaceId: string): Promise<ReadonlySet<string>> {
  const result = await requestTaskPage(workspaceId, {
    page: 1,
    limit: EXISTING_TASK_SCAN_LIMIT,
    grouping: "none",
    sortBy: "createdAt",
    sortDirection: "desc",
  });
  // Degrade silently: a failed read means no badges, never a blocked review.
  if (!result.ok) return new Set<string>();
  return new Set(result.data.items.map((task) => normalizeTitle(task.title)));
}

/** Matches `taskTitleSchema`'s `varchar(500)` bound, so a long item is truncated, not rejected. */
const TASK_TITLE_MAX_CHARS = 500;

/* -------------------------------------------------------------------------- *
 * Component
 * -------------------------------------------------------------------------- */

const DIALOG_ID = "meeting-extraction-dialog";
const TRANSCRIPT_ID = `${DIALOG_ID}-transcript`;
const COUNT_ID = `${DIALOG_ID}-count`;

export function MeetingExtractionDialog({
  workspaceId,
  noteId,
  editor,
  editable,
}: MeetingExtractionDialogProps) {
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<"idle" | "extracting" | "inserting">("idle");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  const status = useQuery({
    queryKey: aiQueryKeys.status(workspaceId),
    queryFn: async () => {
      const result = await fetchAiStatus(workspaceId);
      // A failed status read must not resolve to "AI is off": that is
      // indistinguishable from an admin having disabled it, and the copy for the
      // two is different. Throwing keeps it an error state.
      if (!result.ok) throw new Error(`ai status unavailable: ${result.kind}`);
      return result.data;
    },
    // A note the reader cannot edit offers no AI action, so it asks nothing.
    enabled: editable,
    staleTime: 5 * 60_000,
  });

  const enabled = status.data?.enabled === true;
  const configured = status.data !== undefined && status.data.provider !== "disabled";
  const ready = enabled && configured && editor !== null;

  /** Why the command cannot run, or `null` when it can. Same copy as the panel. */
  const unavailableReason: string | null = status.isPending
    ? null
    : status.isError
      ? STATUS_UNAVAILABLE_MESSAGE
      : !enabled
        ? AI_FAILURE_MESSAGES.AI_DISABLED
        : !configured
          ? AI_FAILURE_MESSAGES.AI_NOT_CONFIGURED
          : null;

  const unavailableRef = useRef(unavailableReason);
  useEffect(() => {
    unavailableRef.current = unavailableReason;
  }, [unavailableReason]);

  /*
   * Opening from a trigger. Registration is already gated on `ready`, so the
   * refusal below only fires in the gap between the render that registered and
   * the press — a status refetch that came back disabled, say. It refuses with
   * the real copy rather than doing nothing, because a command that silently
   * ignores a keystroke is indistinguishable from a broken one.
   */
  const openFromCommand = useCallback((): boolean => {
    setOpen(true);
    const reason = unavailableRef.current;
    if (reason !== null) {
      setError(reason);
      setAnnouncement(reason);
    }
    return true;
  }, []);

  /*
   * Registered through a ref, NOT as a dependency: depending on the callback
   * directly would withdraw and re-register on every render, and
   * `setMeetingExtractionHandler` notifies its subscribers — the slash menu
   * re-renders, which re-renders this, which re-registers. A stable wrapper over
   * a ref registers exactly once per availability change.
   *
   * The cleanup is not optional: a handler that outlives its dialog would open
   * a component that no longer exists.
   */
  const openRef = useRef(openFromCommand);
  useEffect(() => {
    openRef.current = openFromCommand;
  }, [openFromCommand]);

  useEffect(() => {
    if (!editable || !ready) return;
    setMeetingExtractionHandler(() => openRef.current());
    return () => {
      setMeetingExtractionHandler(null);
    };
  }, [editable, ready]);

  const tooLong = transcript.length > AI_MEETING_TRANSCRIPT_MAX_CHARS;

  const extract = useCallback((): void => {
    if (busy !== "idle") return;
    const reason = unavailableRef.current;
    if (reason !== null) {
      setError(reason);
      setAnnouncement(reason);
      return;
    }
    if (transcript.trim().length === 0) {
      setError(EMPTY_TRANSCRIPT_MESSAGE);
      setAnnouncement(EMPTY_TRANSCRIPT_MESSAGE);
      return;
    }
    if (tooLong) {
      setError(TRANSCRIPT_TOO_LONG_MESSAGE);
      setAnnouncement(TRANSCRIPT_TOO_LONG_MESSAGE);
      return;
    }
    setError("");
    setBusy("extracting");
    setAnnouncement(EXTRACTING_MESSAGE);
    void (async () => {
      const result = await requestMeetingExtraction(workspaceId, { transcript });
      if (!result.ok) {
        setBusy("idle");
        setError(failureMessage(result));
        setAnnouncement(failureMessage(result));
        return;
      }
      // Read once, as the review step opens. A failure here is invisible by
      // design — see `existingTaskTitles`.
      const titles = await existingTaskTitles(workspaceId);
      setReview(buildReview(result.data.extraction, titles));
      setBusy("idle");
      setAnnouncement(REVIEW_READY_MESSAGE);
    })();
  }, [busy, tooLong, transcript, workspaceId]);

  const setSectionItem = useCallback(
    (key: PlainSectionKey, index: number, patch: Partial<ReviewItem>): void => {
      setReview((current) =>
        current === null
          ? current
          : {
              ...current,
              sections: current.sections.map((section) =>
                section.key === key
                  ? { ...section, items: patchAt(section.items, index, patch) }
                  : section,
              ),
            },
      );
    },
    [],
  );

  const setActionItem = useCallback((index: number, patch: Partial<ReviewActionItem>): void => {
    setReview((current) =>
      current === null
        ? current
        : { ...current, actionItems: patchAt(current.actionItems, index, patch) },
    );
  }, []);

  const insert = useCallback((): void => {
    if (review === null || busy !== "idle") return;
    if (editor === null) {
      setError(NO_EDITOR_MESSAGE);
      setAnnouncement(NO_EDITOR_MESSAGE);
      return;
    }
    const nodes = meetingNodes(review);
    if (nodes.length === 0) {
      setError(NOTHING_SELECTED_MESSAGE);
      setAnnouncement(NOTHING_SELECTED_MESSAGE);
      return;
    }
    /*
     * `insertContentAt(selection.to)`, NEVER `insertContent`. The latter is
     * `insertContentAt({from: selection.from, to: selection.to})` — it REPLACES
     * the live selection, so an author who had selected a paragraph while
     * reading the review would have it silently deleted by a button labelled
     * "Insert into note". `blockInsertPos` lands the (block-only) meeting nodes
     * after the block holding the selection end, deleting nothing and never
     * splitting the author's paragraph.
     */
    editor.chain().focus().insertContentAt(blockInsertPos(editor), nodes).run();
    setError("");
    setAnnouncement(INSERTED_MESSAGE);

    const wanted = review.actionItems.filter((item) => item.include && item.createTask);
    if (wanted.length === 0) {
      setOpen(false);
      setReview(null);
      setTranscript("");
      return;
    }

    setBusy("inserting");
    void (async () => {
      const failed: string[] = [];
      for (const item of wanted) {
        const title = item.text.trim().slice(0, TASK_TITLE_MAX_CHARS);
        /*
         * `dueDate` on `createTaskSchema` is an ISO INSTANT, not a calendar
         * date, and the model returns `YYYY-MM-DD`. `composeDueDate` is the
         * house conversion the task forms already use: an empty time resolves to
         * midnight LOCAL, because "due Friday" has to mean the Friday the author
         * is looking at rather than a UTC boundary that lands on Thursday
         * evening west of Greenwich. A date the browser cannot parse yields
         * `null` and the field is omitted rather than sent as something the
         * schema would reject.
         */
        const dueDate = item.dueDate === undefined ? null : composeDueDate(item.dueDate, "");
        // A FRESH key per task: one retry-safe identity each, never one shared
        // key that would make the second task a replay of the first.
        const result = await createTask(
          workspaceId,
          { title, noteId, ...(dueDate === null ? {} : { dueDate }) },
          globalThis.crypto.randomUUID(),
        );
        if (!result.ok) failed.push(title);
      }
      setBusy("idle");
      if (failed.length === 0) {
        setOpen(false);
        setReview(null);
        setTranscript("");
        setAnnouncement(
          `${INSERTED_MESSAGE} ${wanted.length} ${wanted.length === 1 ? "task was" : "tasks were"} created.`,
        );
        return;
      }
      /*
       * THE INSERT IS NOT ROLLED BACK. The note content is already the author's
       * — they confirmed every line of it — and undoing their editor transaction
       * to compensate for a task that failed to save would destroy work in order
       * to report a smaller failure. The dialog stays open naming the items so
       * they can be retried or created by hand.
       */
      const message = `The meeting notes were inserted, but these tasks could not be created: ${failed.join(", ")}. The note was not changed back.`;
      setError(message);
      setAnnouncement(message);
    })();
  }, [busy, editor, noteId, review, workspaceId]);

  // Hooks above run unconditionally; the render decision comes after them.
  if (!editable) return null;

  const extracting = busy === "extracting";
  const inserting = busy === "inserting";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing keeps the transcript and the review as they are. Nothing is
        // written without Insert, and discarding a pasted transcript on a
        // stray Escape would be the only destructive thing this dialog does.
        if (!inserting) setOpen(next);
      }}
    >
      <DialogContent
        className="max-w-2xl"
        data-testid="meeting-extraction-dialog"
        aria-describedby={`${DIALOG_ID}-description`}
      >
        <DialogHeader>
          <DialogTitle>Extract meeting notes</DialogTitle>
          <DialogDescription id={`${DIALOG_ID}-description`}>
            Paste a transcript and review what was found. Nothing is added to the note until you
            choose Insert.
          </DialogDescription>
        </DialogHeader>

        {/*
         * The dialog's ONE polite region: outcomes and phase transitions only.
         * No `toast()` — announcements belong to the surface that owns them.
         */}
        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="meeting-announcement"
        >
          {announcement}
        </p>

        {error !== "" ? (
          <p
            className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive"
            data-testid="meeting-error"
          >
            {error}
          </p>
        ) : null}

        {review === null ? (
          <div className="space-y-2">
            <label htmlFor={TRANSCRIPT_ID} className="text-sm font-medium text-foreground">
              Meeting transcript
            </label>
            <textarea
              id={TRANSCRIPT_ID}
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              rows={10}
              aria-describedby={COUNT_ID}
              aria-invalid={tooLong ? true : undefined}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground aria-invalid:border-destructive"
              placeholder="Paste the transcript or meeting notes here."
              data-testid="meeting-transcript"
            />
            <p
              id={COUNT_ID}
              className={tooLong ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
              data-testid="meeting-count"
            >
              {transcript.length.toLocaleString()} of{" "}
              {AI_MEETING_TRANSCRIPT_MAX_CHARS.toLocaleString()} characters
              {tooLong ? ` — ${TRANSCRIPT_TOO_LONG_MESSAGE}` : ""}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {review.sections.map((section) => (
              <section key={section.key} data-testid={`meeting-section-${section.key}`}>
                <h3 className="text-sm font-semibold">{section.heading}</h3>
                {section.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing was found for this section.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {section.items.map((item, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.include}
                          aria-label={`Include ${section.heading} ${index + 1}`}
                          data-testid={`meeting-include-${section.key}-${index}`}
                          onChange={(event) =>
                            setSectionItem(section.key, index, { include: event.target.checked })
                          }
                        />
                        <label htmlFor={`${DIALOG_ID}-${section.key}-${index}`} className="sr-only">
                          {section.heading} {index + 1}
                        </label>
                        <input
                          type="text"
                          id={`${DIALOG_ID}-${section.key}-${index}`}
                          value={item.text}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                          onChange={(event) =>
                            setSectionItem(section.key, index, { text: event.target.value })
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}

            <section data-testid="meeting-section-actionItems">
              <h3 className="text-sm font-semibold">Action items</h3>
              {review.actionItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No action items were found.</p>
              ) : (
                <ul className="mt-2 space-y-3">
                  {review.actionItems.map((item, index) => (
                    <li key={index} className="space-y-1 rounded-md border p-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.include}
                          aria-label={`Include action item ${index + 1}`}
                          data-testid={`meeting-include-actionItems-${index}`}
                          onChange={(event) =>
                            setActionItem(index, { include: event.target.checked })
                          }
                        />
                        <label htmlFor={`${DIALOG_ID}-action-${index}`} className="sr-only">
                          Action item {index + 1}
                        </label>
                        <input
                          type="text"
                          id={`${DIALOG_ID}-action-${index}`}
                          value={item.text}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                          onChange={(event) => setActionItem(index, { text: event.target.value })}
                        />
                        {item.duplicate ? (
                          <span
                            className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                            data-testid={`meeting-duplicate-${index}`}
                          >
                            Already exists
                          </span>
                        ) : null}
                      </div>
                      {item.assignee === undefined && item.dueDate === undefined ? null : (
                        <p className="pl-6 text-xs text-muted-foreground">
                          {[
                            item.assignee === undefined
                              ? undefined
                              : `Assigned to ${item.assignee}`,
                            item.dueDate === undefined ? undefined : `Due ${item.dueDate}`,
                          ]
                            .filter((part) => part !== undefined)
                            .join(" · ")}
                        </p>
                      )}
                      <div className="flex items-center gap-2 pl-6">
                        <input
                          type="checkbox"
                          id={`${DIALOG_ID}-create-task-${index}`}
                          checked={item.createTask}
                          data-testid={`meeting-create-task-${index}`}
                          onChange={(event) =>
                            setActionItem(index, { createTask: event.target.checked })
                          }
                        />
                        <label
                          htmlFor={`${DIALOG_ID}-create-task-${index}`}
                          className="text-xs text-muted-foreground"
                        >
                          Also create a task
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            data-testid="meeting-cancel"
            aria-disabled={inserting ? true : undefined}
            onClick={() => {
              if (inserting) return;
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          {review === null ? (
            <Button
              data-testid="meeting-extract"
              // Never natively disabled: the browser drops a `disabled` element
              // out of the tab order the instant it becomes disabled, and the
              // counter above is what explains why it refuses.
              aria-disabled={tooLong || extracting ? true : undefined}
              aria-describedby={COUNT_ID}
              onClick={extract}
            >
              {extracting ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {extracting ? "Extracting…" : "Extract"}
            </Button>
          ) : (
            <Button
              data-testid="meeting-insert"
              aria-disabled={inserting ? true : undefined}
              onClick={insert}
            >
              {inserting ? "Creating tasks…" : "Insert into note"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
