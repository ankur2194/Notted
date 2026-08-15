"use client";

import { COMMENT_CONTENT_MAX_LENGTH } from "@notted/shared-validators";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, MessageSquare, Pencil, Reply, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CommentAnchorTarget } from "@/components/editor/extensions/comment-decorations";
import type { CommentAnchor, CommentSummary, CommentThread } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";
import type { FormEvent, ReactNode } from "react";

import { createCommentAnchor, resolveCommentAnchor } from "@/components/editor/comment-anchors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getRealtimeSocket } from "@/lib/collaboration/realtime-socket";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import {
  createNoteComment,
  deleteNoteComment,
  requestNoteComments,
  setNoteCommentResolution,
  updateNoteComment,
} from "@/lib/notes/requests";

/**
 * Inline comments (Part 60).
 *
 * ## Where the permission comes from
 *
 * Nowhere new. `NoteDetail.capabilities.canUpdate` is already read by
 * `NoteDetailView` and handed to `NoteEditorSurface` as `editable`, which passes
 * it here as `canResolve`. The backend declares `comment.resolve` over
 * `noteCanEdit`, so those are the same permission, and `comment.create` /
 * `note.read` is what merely opening this page already proves — a viewer or
 * commenter therefore gets the composer and the reply box but no resolve
 * control. **The gate below is presentation only.** The API authorizes every one
 * of these five calls on its own; hiding a button is a courtesy, never a
 * boundary.
 *
 * ## No toasts
 *
 * `sonner` is mounted but no production code calls `toast()`. The house pattern
 * is one polite live region that rewrites itself (`SaveStatusIndicator`), which
 * announces a change once and stays readable afterwards.
 */

/**
 * Server -> note-room broadcast, identifiers only. Declared locally exactly as
 * `presence-client.ts` declares its three: the name lives in
 * `apps/api/src/realtime/realtime.contracts.ts`, and browser code must not
 * import from `apps/api`.
 */
const COMMENT_CHANGED_EVENT = "realtime:comment:changed";

export interface NoteCommentsProps {
  readonly workspaceId: string;
  readonly noteId: string;
  /**
   * Whether this member may resolve a thread. Comes from the note's own
   * authorized capabilities; see the module comment.
   */
  readonly canResolve: boolean;
  /** The signed-in member, used only to offer edit/delete on their own comments. */
  readonly currentUserId?: string;
  /** The live editor. `null` until it mounts; anchors cannot be resolved before that. */
  readonly editor: Editor | null;
  /** Anchored threads, for the decoration plugin. Fires whenever the list changes. */
  readonly onAnchorsChange?: (targets: readonly CommentAnchorTarget[]) => void;
  /** The thread the reader has open, for the active-highlight class. */
  readonly onActiveCommentIdChange?: (commentId: string | null) => void;
}

/** One mutation, four transitions: they share every success and failure path. */
type CommentAction =
  | {
      readonly kind: "create";
      readonly content: string;
      readonly parentId: string | null;
      readonly anchor: CommentAnchor | null;
    }
  | { readonly kind: "update"; readonly commentId: string; readonly content: string }
  | { readonly kind: "delete"; readonly commentId: string }
  | { readonly kind: "resolution"; readonly commentId: string; readonly isResolved: boolean };

const UNAVAILABLE_MESSAGE = "Comments are unavailable right now. Try again in a moment.";

/** Written in two places — the banner a sighted reader sees, and the polite region. */
const OFFLINE_MESSAGE = "You are offline. Comments will send again once you reconnect.";
const ONLINE_MESSAGE = "Back online. Comments can be sent again.";

/** The disclosure's `aria-controls` target. One panel per note view, so a constant is enough. */
const PANEL_ID = "note-comments-panel";

/** Keyed by `ApiRequestFailureKind`, the five-value vocabulary every surface writes from. */
const FAILURE_MESSAGE: Readonly<Record<string, string>> = {
  invalid: "That comment could not be sent. Check the text and try again.",
  "forbidden-or-not-found": "This comment is no longer available, or you no longer have access.",
  conflict: "Someone else changed this comment. It has been reloaded.",
  "version-conflict": "Someone else changed this comment. It has been reloaded.",
  unavailable: UNAVAILABLE_MESSAGE,
};

function failureMessage(kind: string): string {
  return FAILURE_MESSAGE[kind] ?? UNAVAILABLE_MESSAGE;
}

const SUCCESS_MESSAGE: Readonly<Record<CommentAction["kind"], string>> = {
  create: "Comment posted.",
  update: "Comment updated.",
  delete: "Comment deleted.",
  resolution: "Comment resolution updated.",
};

function runAction(workspaceId: string, noteId: string, action: CommentAction) {
  switch (action.kind) {
    case "create":
      return createNoteComment(
        workspaceId,
        noteId,
        { content: action.content, parentId: action.parentId, anchor: action.anchor },
        globalThis.crypto.randomUUID(),
      );
    case "update":
      return updateNoteComment(workspaceId, noteId, action.commentId, { content: action.content });
    case "delete":
      return deleteNoteComment(workspaceId, noteId, action.commentId);
    case "resolution":
      return setNoteCommentResolution(workspaceId, noteId, action.commentId, {
        isResolved: action.isResolved,
      });
  }
}

function formatTimestamp(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/**
 * One app-wide socket serves the whole app and Socket.IO dispatches by EVENT
 * NAME, not by room: a socket holding two note rooms receives both notes'
 * comment frames on this one handler. Part 58 found this as real cross-note
 * corruption. Everything off the wire is `unknown` until proven otherwise, and
 * a frame for another note is dropped before it can invalidate anything.
 */
function isCommentFrameForNote(payload: unknown, noteId: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return (
    typeof record.noteId === "string" &&
    record.noteId === noteId &&
    typeof record.commentId === "string" &&
    typeof record.threadId === "string"
  );
}

/** House offline convention, matching `useNoteAutosave`. */
function useIsOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = (): void => setOffline(navigator.onLine === false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return offline;
}

export function NoteComments({
  workspaceId,
  noteId,
  canResolve,
  currentUserId,
  editor,
  onAnchorsChange,
  onActiveCommentIdChange,
}: NoteCommentsProps) {
  const queryClient = useQueryClient();
  /*
   * ponytail: the panel is a disclosure and fetches nothing until it is opened.
   * Ceiling: no open-comment count on the closed button, so a reader has to open
   * the panel to learn a note has comments. Upgrade path: the note detail
   * payload already carries `progress`; adding an `openCommentCount` there costs
   * one aggregate and would let the button carry a badge without this component
   * fetching on every note open.
   */
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const replyFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const replyReturnRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const offline = useIsOffline();

  const comments = useQuery({
    queryKey: noteQueryKeys.comments(workspaceId, noteId),
    queryFn: async () => {
      const result = await requestNoteComments(workspaceId, noteId);
      // A failed listing must never resolve to "no comments": that would render
      // a commented note as clean, which is exactly the state a reader acts on.
      if (!result.ok) throw new Error(`comments unavailable: ${result.kind}`);
      return result.data;
    },
    enabled: open,
  });

  const threads = useMemo(() => comments.data?.items ?? [], [comments.data]);

  const mutation = useMutation({
    mutationFn: async (action: CommentAction) => {
      const result = await runAction(workspaceId, noteId, action);
      if (!result.ok) throw new Error(result.kind);
      return action;
    },
    onSuccess: async (action) => {
      setAnnouncement(SUCCESS_MESSAGE[action.kind]);
      await queryClient.invalidateQueries({
        queryKey: noteQueryKeys.comments(workspaceId, noteId),
      });
    },
    onError: (error: Error) => setAnnouncement(failureMessage(error.message)),
  });

  /* --------------------------------------------------------------------- *
   * Orphans. A comment whose anchor no longer resolves is listed under its
   * quoted text and draws no decoration. Never hidden, never deleted, never
   * re-guessed — `resolveCommentAnchor` returning `null` IS the signal.
   * --------------------------------------------------------------------- */
  const anchored = useMemo(
    () =>
      threads
        .filter(
          (thread): thread is CommentThread & { readonly anchor: CommentAnchor } =>
            thread.anchor !== null,
        )
        .map((thread) => ({ id: thread.id, anchor: thread.anchor })),
    [threads],
  );

  const [orphanIds, setOrphanIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (editor === null) {
      // Without a document there is nothing to resolve against, so nothing is
      // claimed to be orphaned. An unknown anchor is not a missing one.
      setOrphanIds(new Set());
      return;
    }
    const recompute = (): void => {
      const next = new Set<string>();
      for (const target of anchored) {
        if (resolveCommentAnchor(editor, target.anchor) === null) next.add(target.id);
      }
      setOrphanIds((current) =>
        current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
      );
    };
    recompute();
    // Deleting the commented text is what orphans a comment, and that is a
    // document update rather than a comment-list change.
    editor.on("update", recompute);
    return () => {
      editor.off("update", recompute);
    };
  }, [anchored, editor]);

  // The decoration plugin filters orphans out on its own (an unresolvable anchor
  // yields no decoration), so the whole anchored set is published as-is.
  useEffect(() => {
    onAnchorsChange?.(anchored);
  }, [anchored, onAnchorsChange]);

  useEffect(() => {
    onActiveCommentIdChange?.(activeId);
  }, [activeId, onActiveCommentIdChange]);

  /*
   * Going offline silently inerts every mutating control in this panel, so it is
   * announced rather than left as a banner a screen reader never hears about. It
   * is routed through the one polite region that is mounted for the whole panel
   * — a live region created together with its text is frequently not announced
   * at all, which is exactly what the banner below would be. The first run is
   * skipped so opening the panel while online announces nothing.
   */
  const announcedOffline = useRef(offline);
  useEffect(() => {
    if (announcedOffline.current === offline) return;
    announcedOffline.current = offline;
    setAnnouncement(offline ? OFFLINE_MESSAGE : ONLINE_MESSAGE);
  }, [offline]);

  /* --------------------------------------------------------------------- *
   * Realtime: identifiers only, one action, guarded by note.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    if (!open) return;
    const socket = getRealtimeSocket();
    const handleChanged = (payload: unknown): void => {
      if (!isCommentFrameForNote(payload, noteId)) return;
      // Exactly one thing. The frame carries no content by design, so every
      // client re-reads through the authorized `GET`.
      void queryClient.invalidateQueries({
        queryKey: noteQueryKeys.comments(workspaceId, noteId),
      });
    };
    socket.on(COMMENT_CHANGED_EVENT, handleChanged);
    return () => {
      socket.off(COMMENT_CHANGED_EVENT, handleChanged);
    };
  }, [noteId, open, queryClient, workspaceId]);

  const submitThread = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const content = draft.trim();
      // The submit button is `aria-disabled`, never natively `disabled` (see
      // `submitInert`), so the form is what actually refuses the action: a
      // keyboard press on an `aria-disabled` control still submits.
      if (content.length === 0 || mutation.isPending || offline) return;
      /*
       * Both editor modes. `createCommentAnchor` reads the Yjs binding when
       * there is one and produces a `yrel:1` anchor; in solo mode there is no
       * binding, so it produces a `pmabs:1` anchor from absolute positions
       * instead. Commenting therefore works identically in both, and `null` — a
       * collapsed selection, or no editor yet — is a whole-note comment, which
       * the contract models explicitly.
       */
      const anchor =
        editor === null
          ? null
          : createCommentAnchor(editor, editor.state.selection.from, editor.state.selection.to);
      mutation.mutate(
        { kind: "create", content, parentId: null, anchor },
        { onSuccess: () => setDraft("") },
      );
    },
    [draft, editor, mutation, offline],
  );

  const submitReply = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const content = replyDraft.trim();
      if (content.length === 0 || replyTo === null || mutation.isPending || offline) return;
      mutation.mutate(
        { kind: "create", content, parentId: replyTo, anchor: null },
        {
          onSuccess: () => {
            setReplyDraft("");
            setReplyTo(null);
            replyReturnRef.current?.focus();
          },
        },
      );
    },
    [mutation, offline, replyDraft, replyTo],
  );

  const submitEdit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const content = editDraft.trim();
      if (content.length === 0 || editingId === null || mutation.isPending || offline) return;
      mutation.mutate(
        { kind: "update", commentId: editingId, content },
        { onSuccess: () => setEditingId(null) },
      );
    },
    [editDraft, editingId, mutation, offline],
  );

  // Focus moves into the reply box when a thread opens it, and back to the
  // control that opened it when it closes.
  useEffect(() => {
    if (replyTo !== null) replyFieldRef.current?.focus();
  }, [replyTo]);

  const busy = mutation.isPending;
  const inFlight = mutation.isPending ? mutation.variables : undefined;
  const pendingCommentId =
    inFlight !== undefined && "commentId" in inFlight ? inFlight.commentId : null;
  /*
   * Every mutating control in this panel is unavailable for the same two
   * reasons, and NONE of them is ever natively `disabled`: the browser removes a
   * `disabled` element from the tab order the instant it becomes disabled, which
   * — when the disabling is the user's own keypress — drops focus onto `<body>`
   * mid-task. `aria-disabled` keeps the control focusable and announces it as
   * unavailable; the handlers above and below are what make it inert. Same rule,
   * same shape as `PageContainer`'s zoom controls.
   */
  const submitInert = busy || offline;

  const renderBody = (comment: CommentSummary): ReactNode => {
    if (editingId !== comment.id) return <p className="whitespace-pre-wrap">{comment.content}</p>;
    return (
      <form className="space-y-2" onSubmit={submitEdit}>
        <label className="sr-only" htmlFor={`comment-edit-${comment.id}`}>
          Edit comment
        </label>
        <textarea
          id={`comment-edit-${comment.id}`}
          className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
          maxLength={COMMENT_CONTENT_MAX_LENGTH}
          value={editDraft}
          onChange={(event) => setEditDraft(event.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" aria-disabled={submitInert ? true : undefined}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  };

  const renderComment = (comment: CommentSummary, isRoot: boolean): ReactNode => (
    <article
      aria-labelledby={`comment-author-${comment.id}`}
      className="space-y-2 text-sm"
      data-comment-id={comment.id}
    >
      <p className="flex flex-wrap items-baseline gap-2">
        <span id={`comment-author-${comment.id}`} className="font-medium">
          {comment.createdBy.name}
        </span>
        <time className="text-xs text-muted-foreground" dateTime={comment.createdAt}>
          {formatTimestamp(comment.createdAt)}
        </time>
      </p>
      {renderBody(comment)}
      {isRoot &&
      comment.isResolved &&
      comment.resolvedBy !== null &&
      comment.resolvedAt !== null ? (
        <p className="text-xs text-muted-foreground">
          Resolved by {comment.resolvedBy.name} on{" "}
          <time dateTime={comment.resolvedAt}>{formatTimestamp(comment.resolvedAt)}</time>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {isRoot ? (
          <Button
            ref={replyTo === comment.id ? replyReturnRef : undefined}
            size="sm"
            variant="ghost"
            onClick={() => {
              setReplyDraft("");
              setReplyTo((current) => (current === comment.id ? null : comment.id));
            }}
            aria-expanded={replyTo === comment.id}
          >
            <Reply aria-hidden="true" /> Reply
          </Button>
        ) : null}
        {/*
         * Resolve applies to the THREAD ROOT server-side, so it is offered on a
         * root only — a control on a reply would silently act on its parent.
         * Hidden without edit permission; the API is the real enforcement.
         */}
        {isRoot && canResolve ? (
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={submitInert ? true : undefined}
            onClick={() => {
              if (submitInert) return;
              mutation.mutate({
                kind: "resolution",
                commentId: comment.id,
                isResolved: !comment.isResolved,
              });
            }}
          >
            {comment.isResolved ? (
              <>
                <Undo2 aria-hidden="true" /> Reopen
              </>
            ) : (
              <>
                <Check aria-hidden="true" /> Resolve
              </>
            )}
          </Button>
        ) : null}
        {currentUserId !== undefined && comment.createdBy.id === currentUserId ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditDraft(comment.content);
                setEditingId(comment.id);
              }}
            >
              <Pencil aria-hidden="true" /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-disabled={submitInert ? true : undefined}
              onClick={() => {
                if (submitInert) return;
                mutation.mutate(
                  { kind: "delete", commentId: comment.id },
                  {
                    /*
                     * The comment this button lives in is about to unmount, so
                     * focus has to be handed somewhere deliberate — otherwise it
                     * falls to `<body>` and a keyboard reader restarts the whole
                     * page. The panel heading is the nearest stable landmark
                     * above the list, and the polite region announces "Comment
                     * deleted." in the same tick.
                     */
                    onSuccess: () => headingRef.current?.focus(),
                  },
                );
              }}
            >
              <Trash2 aria-hidden="true" /> Delete
            </Button>
          </>
        ) : null}
        {pendingCommentId === comment.id ? (
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            role="status"
            aria-label="Working"
          />
        ) : null}
      </div>
    </article>
  );

  const renderThread = (thread: CommentThread, orphaned: boolean): ReactNode => (
    <li
      key={thread.id}
      className={`rounded-lg border p-3 ${thread.isResolved ? "bg-muted/40" : "bg-card"}`}
      data-testid="comment-thread"
      /*
       * The open thread is whichever one holds focus. No extra "select this
       * thread" control and no click handler on a non-interactive element: the
       * thread's own buttons and fields are what a reader reaches for anyway,
       * and focus is the one signal both keyboard and pointer produce.
       */
      onFocusCapture={() => setActiveId(thread.id)}
    >
      {orphaned ? (
        <p className="mb-2 text-xs text-muted-foreground">
          commented on: “{thread.anchor?.quote ?? ""}”
        </p>
      ) : null}
      {renderComment(thread, true)}
      {thread.replies.length > 0 ? (
        <ul className="mt-3 space-y-3 border-l pl-3" aria-label="Replies">
          {thread.replies.map((reply) => (
            <li key={reply.id}>{renderComment(reply, false)}</li>
          ))}
        </ul>
      ) : null}
      {replyTo === thread.id ? (
        <form className="mt-3 space-y-2" onSubmit={submitReply}>
          <label className="sr-only" htmlFor={`comment-reply-${thread.id}`}>
            Reply to {thread.createdBy.name}
          </label>
          <textarea
            id={`comment-reply-${thread.id}`}
            ref={replyFieldRef}
            className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
            maxLength={COMMENT_CONTENT_MAX_LENGTH}
            value={replyDraft}
            onChange={(event) => setReplyDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              data-testid="comment-reply-submit"
              aria-disabled={submitInert ? true : undefined}
            >
              Post reply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplyTo(null);
                replyReturnRef.current?.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );

  const live = threads.filter((thread) => !orphanIds.has(thread.id));
  const orphans = threads.filter((thread) => orphanIds.has(thread.id));

  return (
    /*
     * ONE toggle, mounted in both states. The panel used to be two disjoint
     * renders — a "Comments" button, or a section with its own "Hide comments"
     * button — so opening it unmounted the control the reader had just pressed
     * and closing it unmounted the other one: focus landed on `<body>` on BOTH
     * transitions. A single persistent button that owns `aria-expanded` and
     * `aria-controls` is the standard disclosure, keeps focus where the reader
     * put it, and needs no focus-restoration code at all.
     */
    <div className="space-y-4" data-notted-print-hide>
      <Button
        variant={open ? "ghost" : "outline"}
        size="sm"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        data-testid="note-comments-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        <MessageSquare aria-hidden="true" /> {open ? "Hide comments" : "Comments"}
      </Button>
      {open ? (
        <section
          id={PANEL_ID}
          aria-labelledby="note-comments-heading"
          className="space-y-4 rounded-xl border bg-card p-4"
          data-testid="note-comments"
        >
          <h2
            id="note-comments-heading"
            // Focusable only programmatically: the delete handler hands focus
            // here when the comment that held it disappears.
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold"
          >
            Comments
            {comments.data === undefined ? null : (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {comments.data.openCount} open
              </span>
            )}
          </h2>

          <p
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="note-comments-announcement"
          >
            {announcement}
          </p>

          {offline ? (
            <p className="rounded-md border bg-muted/40 p-3 text-sm" role="note">
              {OFFLINE_MESSAGE}
            </p>
          ) : null}

          {comments.isPending ? (
            <div role="status" aria-label="Loading comments" className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}

          {comments.isError ? (
            <div className="rounded-lg border border-destructive/40 p-3 text-sm" role="alert">
              <p>Comments could not be loaded.</p>
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => void comments.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {comments.isSuccess && threads.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              No comments yet. Select text in the note, or write below to comment on the whole note.
            </p>
          ) : null}

          {live.length > 0 ? (
            <ul className="space-y-3" aria-label="Comment threads">
              {live.map((thread) => renderThread(thread, false))}
            </ul>
          ) : null}

          {orphans.length > 0 ? (
            <div className="space-y-2">
              <h3 id="note-comments-orphaned-heading" className="text-sm font-semibold">
                Orphaned
              </h3>
              <p className="text-xs text-muted-foreground">
                The text these comments pointed at is gone. They are kept exactly as written and are
                not highlighted in the note.
              </p>
              <ul className="space-y-3" aria-labelledby="note-comments-orphaned-heading">
                {orphans.map((thread) => renderThread(thread, true))}
              </ul>
            </div>
          ) : null}

          <form className="space-y-2 border-t pt-3" onSubmit={submitThread}>
            <label className="block text-sm font-medium" htmlFor="note-comment-new">
              Add a comment
            </label>
            <p id="note-comment-new-hint" className="text-xs text-muted-foreground">
              Anything you have selected in the note is attached to the comment.
            </p>
            <textarea
              id="note-comment-new"
              aria-describedby="note-comment-new-hint"
              className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
              maxLength={COMMENT_CONTENT_MAX_LENGTH}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              data-testid="comment-submit"
              aria-disabled={submitInert || draft.trim().length === 0 ? true : undefined}
            >
              Comment
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
