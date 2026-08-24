"use client";

import { ATTACHMENT_UPLOAD_ACCEPT, safeParseNoteDocument } from "@notted/shared-validators";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ImageUploadFileInput } from "./ImageUploadFileInput";
import { useHasNoteSaveHost, useNoteSave } from "./note-save-context";
import { NoteComments } from "./NoteComments";
import { PresenceBar } from "./PresenceBar";
import { useImageUploads } from "./useImageUploads";

import type { CommentAnchorTarget } from "@/components/editor/extensions/comment-decorations";
import type { Editor } from "@tiptap/core";

import { AiPanel } from "@/components/ai/AiPanel";
import {
  createAttachmentDirectory,
  documentHasAttachment,
  documentHasImage,
} from "@/components/editor/attachment-directory";
import { refreshCommentDecorations } from "@/components/editor/extensions/comment-decorations";
import {
  createDebouncedSearch,
  createMentionDirectory,
  documentHasMention,
  filterMentionCandidates,
  mentionCandidates,
  type MentionCandidate,
} from "@/components/editor/mention-members";
import { TiptapEditor } from "@/components/editor/TiptapEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { getRealtimeSocket } from "@/lib/collaboration/realtime-socket";
import { useNoteCollaboration } from "@/lib/collaboration/useNoteCollaboration";
import { attachmentEntries, requestNoteAttachments } from "@/lib/notes/attachment-requests";
import { fetchWorkspaceMemberDirectory } from "@/lib/notes/member-directory";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import { useNotePresence } from "@/lib/realtime/presence-client";

export interface NoteEditorSurfaceProps {
  /**
   * Always the workspace of the note being edited. It is never derived from a
   * mention query, a URL fragment, or any other caller-supplied value, so the
   * member request can only ever address this workspace. Tenant isolation
   * itself stays where it belongs: `memberships.service.ts#listMembers`.
   */
  readonly workspaceId: string;
  readonly noteId: string;
  readonly initialDocument: unknown;
  readonly editable: boolean;
  readonly ariaLabel?: string;
  readonly readOnlyReason?: string;
  /**
   * Historical previews render inside the live note's save provider but must
   * never publish their document as a baseline or change. Defaults to true for
   * the ordinary editor; Part 56 passes false for immutable previews.
   */
  readonly bindToNoteSave?: boolean;
  /**
   * The signed-in member, used only as the identity of this editing session
   * (Part 58). Absent keeps the note solo: without an identity there is no
   * awareness state worth publishing, and the read-only version preview has no
   * session of its own to name.
   */
  readonly userId?: string;
  readonly userName?: string;
  /** Part 39 seam, and how tests drive the real editor through this wrapper. */
  readonly onEditorReady?: (editor: Editor | null) => void;
}

/**
 * Shown to *other* people as this writer's cursor label, and as an unresolved
 * viewer's name in the presence roster.
 *
 * Nothing on the wire carries a display name: `AuthenticatedPrincipal` holds
 * `userId` only, and `NoteDetail` exposes `currentActorId` without a name. Part
 * 59 resolves the name client-side instead, from the workspace member directory
 * this component already caches — so this is no longer the usual case, only the
 * fallback for an id the directory does not contain (a member removed mid
 * session, or a directory that failed to load). Both are states where claiming
 * a name would be worse than declining to.
 */
const UNNAMED_COLLABORATOR = "Workspace member";

/**
 * Client boundary that gives `TiptapEditor` its workspace-scoped member data.
 *
 * The editor itself performs no I/O: it receives an injected search callback
 * and a directory object. Both are built here from the same authorized member
 * listing the share dialog uses, through TanStack Query, so the list is fetched
 * once per workspace and shared.
 */
export function NoteEditorSurface({
  workspaceId,
  noteId,
  initialDocument,
  editable,
  ariaLabel,
  readOnlyReason,
  bindToNoteSave = true,
  userId,
  userName,
  onEditorReady,
}: NoteEditorSurfaceProps) {
  const queryClient = useQueryClient();
  // Part 39. The editor arrives inside `PageContainer` as opaque `children`
  // rendered by a Server Component, so the save handle is read from context
  // rather than threaded as a prop. Outside a provider every method is a no-op.
  const save = useNoteSave();
  // Whether anything is actually showing save state. The editor keeps its own
  // contract-rejection alert unless a host takes ownership of announcing it.
  const hasSaveHost = useHasNoteSaveHost();

  // Only notes that already store mentions need the directory on load. Fetching
  // it unconditionally would spend up to `WORKSPACE_MEMBER_MAX_PAGES` sequential
  // requests opening a note that never shows a mention. A disabled query still
  // observes its cache entry, so the first `@` — which populates the same key
  // through `mentionSearch` — fills the directory here too.
  const needsDirectory = useMemo(() => documentHasMention(initialDocument), [initialDocument]);

  /*
   * Part 58. Who is allowed to open a socket at all.
   *
   * `editable` excludes readers, and `bindToNoteSave` excludes the Part 56
   * historical preview, which renders inside the live note's save provider but
   * is immutable by definition. Both are decided here rather than inside the
   * provider so a preview never even attempts a connection.
   */
  const collaborationEnabled = editable && bindToNoteSave && userId !== undefined;

  const members = useQuery({
    queryKey: noteQueryKeys.members(workspaceId),
    queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
    // Part 59 widens the gate: a collaborative session needs the directory to
    // put a name on this writer's caret and on every other viewer in the
    // presence bar. Same key, so a note that also stores mentions still issues
    // exactly one listing request.
    enabled: needsDirectory || collaborationEnabled,
  });

  // Created once and mutated: node views subscribe to it, and replacing the
  // object would mean rebuilding the editor.
  const directoryRef = useRef(createMentionDirectory());
  const directory = directoryRef.current;

  useEffect(() => {
    // `null` means "not loaded or unavailable", which renders every stored
    // mention neutrally instead of falsely claiming the person was removed.
    if (members.data === undefined) {
      directory.setMembers(null);
      return;
    }
    directory.setMembers(mentionCandidates(members.data));
  }, [directory, members.data]);

  const mentionSearch = useMemo(
    () =>
      createDebouncedSearch<MentionCandidate>(async (query) => {
        const page = await queryClient.fetchQuery({
          queryKey: noteQueryKeys.members(workspaceId),
          queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
        });
        // The member listing has no server-side name filter, so the authorized
        // pages are fetched once, cached under one key, and matched on the
        // client. The query string is therefore never part of a request path.
        return filterMentionCandidates(query, mentionCandidates(page));
      }),
    [queryClient, workspaceId],
  );

  useEffect(() => () => mentionSearch.cancel(), [mentionSearch]);

  // Part 42, gated exactly like the member directory: only a note that already
  // stores an image has anything to resolve on open. A note without one fetches
  // nothing until an upload happens, and that upload seeds the same cache entry.
  //
  // Part 44 widens the gate to attachment cards. Both node types resolve through
  // the same directory and the same cache key, so a note holding either issues
  // exactly one listing request — never two.
  const needsAttachments = useMemo(
    () => documentHasImage(initialDocument) || documentHasAttachment(initialDocument),
    [initialDocument],
  );

  const attachments = useQuery({
    queryKey: noteQueryKeys.attachments(workspaceId, noteId),
    queryFn: async () => {
      const result = await requestNoteAttachments(workspaceId, noteId);
      // A failed listing must not resolve to "no attachments", or every stored
      // image would render as permanently deleted. Throwing keeps the directory
      // `null`, which renders them as still loading.
      if (!result.ok) throw new Error(`attachments unavailable: ${result.kind}`);
      return result.data;
    },
    enabled: needsAttachments,
  });

  // Created once and mutated, for the same reason as the mention directory:
  // node views subscribe to it, and replacing the object would mean rebuilding
  // the editor and discarding editing history.
  const attachmentDirectoryRef = useRef(createAttachmentDirectory());
  const attachmentDirectory = attachmentDirectoryRef.current;

  useEffect(() => {
    // `null` means "not loaded or unavailable", which renders a stored image as
    // loading rather than falsely claiming the attachment was deleted.
    if (attachments.data === undefined) {
      if (!needsAttachments) return;
      attachmentDirectory.setEntries(null);
      return;
    }
    attachmentDirectory.setEntries(attachmentEntries(attachments.data));
  }, [attachmentDirectory, attachments.data, needsAttachments]);

  const images = useImageUploads({
    workspaceId,
    noteId,
    directory: attachmentDirectory,
    editable,
  });

  const directoryName = useMemo(
    () =>
      userId === undefined
        ? null
        : (members.data?.items.find((member) => member.userId === userId)?.name ?? null),
    [members.data, userId],
  );

  /*
   * Part 59. The first name the directory yields for this session, and then
   * never again.
   *
   * `collaborationUser` is a dependency of `useNoteCollaboration`'s effect, so
   * every change to the name tears the provider down and re-runs the handshake.
   * Latching the first non-fallback resolution bounds that at exactly one
   * re-handshake, which happens while the directory request is still in flight —
   * before anyone has typed — instead of on every directory refetch for the rest
   * of the session.
   */
  const [resolvedName, setResolvedName] = useState<string | null>(null);

  useEffect(() => {
    if (resolvedName !== null || directoryName === null) return;
    setResolvedName(directoryName);
  }, [directoryName, resolvedName]);

  const collaborationUser = useMemo(
    () => ({ id: userId ?? "", name: userName ?? resolvedName ?? UNNAMED_COLLABORATOR }),
    [resolvedName, userId, userName],
  );

  const [collaborationNotice, setCollaborationNotice] = useState("");

  const handleProjected = useCallback(
    (version: number): void => {
      // The projection wrote `notes.content` server-side; autosave adopts the
      // version only while it has nothing of its own outstanding.
      save.applyExternalVersion(version);
    },
    [save],
  );

  const handleReset = useCallback((): void => {
    /*
     * ponytail: unsent local edits are deliberately discarded on a reset. The
     * server has replaced the shared document — a version restore — so the epoch
     * bump remounts the editor onto the fresh Y.Doc and anything typed between
     * the restore and the reset is gone. Keeping it would mean diffing two
     * unrelated documents and asking the writer to merge them; add that only if
     * restores during live editing turn out to be common.
     */
    setCollaborationNotice("This note was restored to an earlier version");
  }, []);

  const { mode, binding, generation, status } = useNoteCollaboration({
    enabled: collaborationEnabled,
    workspaceId,
    noteId,
    user: collaborationUser,
    onProjected: handleProjected,
    onReset: handleReset,
  });

  /*
   * Part 59. Who else is here. `binding.awareness` is read fresh on every render
   * on purpose: an epoch reset replaces the document *and* its awareness
   * together, so a client id captured once would name a torn-down instance.
   */
  const roster = useNotePresence({
    enabled: mode === "collaborative",
    workspaceId,
    noteId,
    awarenessClientId: binding?.awareness.clientID ?? null,
    // The gateway denies an announce from a socket that does not already hold
    // the note room, and that room is entered by the (asynchronous) Part 58
    // handshake. This is the only safe "the server is ready for us" signal.
    synced: status === "synced",
  });

  // The socket is process-wide and reconnects on its own until its attempt
  // budget runs out; this is the manual re-dial for after that.
  const handleReconnect = useCallback((): void => {
    getRealtimeSocket().connect();
  }, []);

  /*
   * One writer at a time. A collaborative editor never drives the Part 39
   * autosave machine — the API's projection is the only writer of
   * `notes.content` while the session is live — and a note that never opened a
   * session keeps the autosave binding byte-for-byte as it was.
   *
   * ponytail: if realtime fails for one user only, that user is a solo writer
   * for up to ~2s (the projection debounce); their save wins the CAS and the
   * collaborative side is force-reloaded from `notes.content` rather than
   * silently clobbered. Closing it fully needs a Redis "collaborative session
   * active" check on `NotesService.update`, which puts Redis on the core
   * note-save path.
   */
  /*
   * The session is live but the server has stopped taking its writes (the
   * provider exhausted its bounded update retries). The editor is deliberately
   * NOT remounted into solo mode — its content lives in the shared `Y.Doc`, and
   * a remount would reload the note as it was when the page opened — so the pen
   * goes back to the Part 39 autosave in place. Anything else leaves the note
   * with no writer at all under a status line claiming it is live.
   */
  const collaborationWriteFailed = mode === "collaborative" && status === "error";
  const effectiveSaveBinding =
    bindToNoteSave && (!collaborationEnabled || mode === "solo" || collaborationWriteFailed);
  // The handshake has its own budget (1500 ms) inside the provider, so this is
  // bounded: it resolves to `collaborative` or falls back to `solo`.
  const pendingHandshake = collaborationEnabled && mode === "pending";

  /**
   * Hand autosave the editor's own serialization of the document it opened
   * with, before any editing happens.
   *
   * ProseMirror fills in default attributes the stored contract document omits,
   * so the server's JSON and the editor's JSON for identical content are not
   * byte-identical. Without this baseline, typing a character and deleting it
   * again would look like a real change and issue a pointless save.
   */
  /*
   * Part 60. Comments live here for the same reason `PresenceBar` does:
   * `PageContainer` receives the editor as opaque `children` from a Server
   * Component and can reach neither `workspaceId` nor the editor instance.
   *
   * `bindToNoteSave` is the gate — a Part 56 historical preview is an immutable
   * rendering of a past version, and commenting on one would anchor against a
   * document nobody can edit.
   */
  const commentsEnabled = bindToNoteSave;
  /*
   * Part 68. Same gate, same reason: a historical preview is an immutable
   * rendering of a past version, and every AI action here ends in a transaction
   * against the live document.
   */
  const aiEnabled = bindToNoteSave;
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const commentTargetsRef = useRef<readonly CommentAnchorTarget[]>([]);
  const activeCommentIdRef = useRef<string | null>(null);

  // Stable for the lifetime of this component, so `TiptapEditor` can capture
  // them once into its `useMemo(…, [])` extension list.
  const resolveComments = useCallback((): readonly CommentAnchorTarget[] => {
    return commentTargetsRef.current;
  }, []);
  const resolveActiveCommentId = useCallback((): string | null => activeCommentIdRef.current, []);

  const refreshDecorations = useCallback((): void => {
    const instance = editorRef.current;
    // An empty, meta-only transaction — no steps, so history, Yjs, and autosave
    // never see it. Skipped once the view is gone.
    if (instance !== null && !instance.isDestroyed) refreshCommentDecorations(instance);
  }, []);

  const handleAnchorsChange = useCallback(
    (targets: readonly CommentAnchorTarget[]): void => {
      commentTargetsRef.current = targets;
      refreshDecorations();
    },
    [refreshDecorations],
  );

  const handleActiveCommentIdChange = useCallback(
    (commentId: string | null): void => {
      activeCommentIdRef.current = commentId;
      refreshDecorations();
    },
    [refreshDecorations],
  );

  const handleEditorReady = useCallback(
    (instance: Editor | null): void => {
      if (effectiveSaveBinding && instance !== null) {
        const parsed = safeParseNoteDocument(instance.getJSON());
        if (parsed.success) save.onDocumentBaseline(parsed.doc);
      }
      editorRef.current = instance;
      setEditorInstance(instance);
      onEditorReady?.(instance);
    },
    [effectiveSaveBinding, onEditorReady, save],
  );

  return (
    <>
      {/*
       * Application chrome, next to the save status the page container renders:
       * connection state and who else is here (Part 59), plus one polite region
       * for the restore notice so a
       * reset is announced rather than only visible. The region is mounted for
       * the whole session — empty until there is something to say — because a
       * live region created together with its text is often not announced. A
       * note that never opens a session renders none of this.
       */}
      {collaborationEnabled ? (
        <div className="flex flex-wrap items-center gap-3" data-notted-print-hide>
          <PresenceBar
            mode={mode}
            status={status}
            workspaceId={workspaceId}
            roster={roster}
            selfUserId={userId}
            onReconnect={handleReconnect}
          />
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="note-collab-notice"
            className="text-sm text-muted-foreground"
          >
            {collaborationNotice}
          </p>
        </div>
      ) : null}
      {pendingHandshake ? (
        <div data-testid="note-collaboration-pending" data-notted-print-hide>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        /*
         * One mode per editor instance. The key makes a mode change — and every
         * replacement of the shared document — a remount onto the fresh document
         * instead of an in-place swap no ProseMirror plugin set could survive.
         *
         * Keyed on the provider's generation, NOT its epoch. A server reset
         * raises the epoch before rebuilding, but a `stale` update ack rebuilds
         * while the epoch is still the old one, so an epoch key left the editor
         * mounted over a destroyed `Y.Doc` with its update listener detached for
         * the whole re-handshake. Everything typed in that window reached neither
         * the wire nor the new document, and autosave is not a backstop in
         * collaborative mode.
         */
        <TiptapEditor
          key={mode === "collaborative" ? `collab:${generation}` : "solo"}
          noteId={noteId}
          initialDocument={initialDocument}
          editable={editable}
          ariaLabel={ariaLabel}
          readOnlyReason={readOnlyReason}
          mentionSearch={mentionSearch}
          mentionDirectory={directory}
          mentionDirectoryTruncated={members.data?.hasMore === true}
          uploadImages={editable ? images.uploadImages : undefined}
          onRequestImageFiles={editable ? images.requestImageFiles : undefined}
          uploadAttachments={editable ? images.uploadAttachments : undefined}
          onRequestAttachmentFiles={editable ? images.requestAttachmentFiles : undefined}
          workspaceId={workspaceId}
          attachmentDirectory={attachmentDirectory}
          collaboration={mode === "collaborative" ? binding : null}
          collaborationWriteFailed={collaborationWriteFailed}
          onDocumentChange={effectiveSaveBinding ? save.onDocumentChange : undefined}
          onDocumentRejected={
            effectiveSaveBinding && hasSaveHost ? save.onDocumentRejected : undefined
          }
          onEditorReady={handleEditorReady}
          resolveComments={commentsEnabled ? resolveComments : undefined}
          resolveActiveCommentId={commentsEnabled ? resolveActiveCommentId : undefined}
        />
      )}
      {commentsEnabled ? (
        <NoteComments
          workspaceId={workspaceId}
          noteId={noteId}
          /*
           * `comment.resolve` is declared over `noteCanEdit` server-side, and
           * `editable` here IS `NoteDetail.capabilities.canUpdate` (minus a
           * trashed note) as `NoteDetailView` computed it. No new permission
           * fetch, and no new capability invented: a viewer or commenter can
           * still comment and reply, they simply are not offered resolve. The
           * API authorizes every call regardless of what is rendered.
           */
          canResolve={editable}
          currentUserId={userId}
          editor={editorInstance}
          onAnchorsChange={handleAnchorsChange}
          onActiveCommentIdChange={handleActiveCommentIdChange}
        />
      ) : null}
      {aiEnabled ? (
        <AiPanel
          workspaceId={workspaceId}
          noteId={noteId}
          editor={editorInstance}
          /*
           * `editable` is `NoteDetail.capabilities.canUpdate` minus a trashed
           * note, exactly as `NoteDetailView` computed it. A viewer is offered no
           * AI action at all, because every accept path here writes to the
           * document. The API authorizes each generation regardless.
           */
          editable={editable}
        />
      ) : null}
      {/*
       * The picker lives here rather than inside the editor: a file input is a
       * DOM control with its own lifecycle, and the editor performs no I/O and
       * owns no dialogs. Its visible, accessible triggers are the toolbar's
       * "Insert image" button and the `/image` command.
       */}
      {editable ? (
        <>
          <ImageUploadFileInput ref={images.fileInputRef} onFiles={images.handlePickedFiles} />
          {/*
           * A second input rather than one with a swapped `accept` (Part 44):
           * `accept` must be correct *before* `click()`, and mutating it between
           * an image request and a file request is a race the writer would
           * experience as the wrong dialog filter.
           */}
          <ImageUploadFileInput
            ref={images.attachmentInputRef}
            onFiles={images.handlePickedAttachmentFiles}
            label="Choose files to attach"
            accept={ATTACHMENT_UPLOAD_ACCEPT}
            testId="note-attachment-file-input"
          />
        </>
      ) : null}
    </>
  );
}
