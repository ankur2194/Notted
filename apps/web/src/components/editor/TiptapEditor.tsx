"use client";

import { safeParseNoteDocument, type NoteDocument } from "@notted/shared-validators";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AttachmentDialogs } from "./AttachmentDialogs";
import { prepareNoteDocumentForEditor } from "./document-contract";
import { areDocumentsEquivalent } from "./document-sync";
import { EditorToolbar } from "./EditorToolbar";
import { EditorShortcuts, type EditorShortcutHandlerMap } from "./extensions/editor-shortcuts";
import { createNoteEditorExtensions } from "./extensions/note-editor-extensions";
import { ImageToolbar } from "./ImageToolbar";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { MentionList } from "./MentionList";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { openMentionMenuAtCaret, openSlashMenuAtCaret } from "./suggestion-triggers";
import { FOCUS_TOOLBAR_GROUPS } from "./toolbar-commands";
import { useSuggestionPopup } from "./useSuggestionPopup";

import type { AttachmentDirectory } from "./attachment-directory";
import type { CommentAnchorTarget } from "./extensions/comment-decorations";
import type {
  AttachmentFilePickerHandler,
  AttachmentUploadHandler,
} from "./extensions/CustomAttachment";
import type { ImageFilePickerHandler, ImageUploadHandler } from "./extensions/CustomImage";
import type { MentionCandidate, MentionDirectory } from "./mention-members";
import type { SlashCommand } from "./slash-commands";
import type { NoteCollaborationBinding } from "@/lib/collaboration/note-collaboration-provider";
import type { Editor } from "@tiptap/core";

import { requestAiContinue, useAiContinueAvailable } from "@/lib/ai/continue-request";
import { toggleFocusMode, useFocusMode } from "@/lib/notes/focus-mode";

const DEFAULT_ARIA_LABEL = "Note content";

export interface TiptapEditorProps {
  /** Untrusted or historical TipTap JSON; always migrated before it reaches the editor. */
  readonly initialDocument: unknown;
  readonly editable: boolean;
  readonly noteId: string;
  readonly ariaLabel?: string;
  /** Explains why editing is unavailable when `editable` is false. */
  readonly readOnlyReason?: string;
  /** Part 39 seam: fires with contract-valid JSON on every change. Nothing is persisted here. */
  readonly onDocumentChange?: (document: NoteDocument) => void;
  /**
   * Part 39 seam: reports whether the *last* transaction produced JSON the note
   * contract rejects. When it does, `onDocumentChange` is deliberately not
   * called — so without this signal autosave would simply go quiet while the
   * writer kept typing. It exists so that state can be surfaced, never hidden.
   * This component still performs no I/O of any kind.
   *
   * Supplying it also transfers ownership of the *announcement*: the host is
   * expected to report the rejection, so this component stops rendering its own
   * `role="alert"` and one event produces one assertive message.
   */
  readonly onDocumentRejected?: (rejected: boolean) => void;
  /** Part 35/39 seam: receives the live instance, and `null` once it is destroyed. */
  readonly onEditorReady?: (editor: Editor | null) => void;
  /**
   * Workspace-scoped member lookup for `@` mentions, injected by the host so
   * this component performs no network I/O of its own. Absent means mentions
   * find nobody rather than searching something wider.
   */
  readonly mentionSearch?: (query: string) => Promise<readonly MentionCandidate[]>;
  /** Current workspace members, used only to render existing mentions. */
  readonly mentionDirectory?: MentionDirectory | null;
  /**
   * True when the host could not load every workspace member. It only changes
   * the wording of the mention menu's empty state, so "no match" is never
   * presented as "not a member of this workspace".
   */
  readonly mentionDirectoryTruncated?: boolean;
  /**
   * Part 42 seam. Receives the files from a paste, a drop, or the file picker
   * together with a controller for the placeholder decorations, and owns the
   * whole upload. This component still performs no I/O of any kind: it never
   * learns what an attachment is, only that something can be handed files.
   * Absent means paste and drop decline and the images are left alone.
   */
  readonly uploadImages?: ImageUploadHandler;
  /**
   * Part 42 seam. Asked to open the host-owned `<input type="file">` when the
   * `/image` command or the toolbar button runs. The host is the owner because
   * a file input is a DOM control with its own lifecycle, not editor state.
   */
  readonly onRequestImageFiles?: ImageFilePickerHandler;
  /**
   * Part 44 seams, identical in shape and in reasoning to the image pair above:
   * this component still performs no I/O, owns no file input, and never learns
   * what an attachment is. Absent means paste and drop of a non-image file
   * decline and nothing is inserted.
   */
  readonly uploadAttachments?: AttachmentUploadHandler;
  readonly onRequestAttachmentFiles?: AttachmentFilePickerHandler;
  /**
   * The workspace of the note being edited (Part 44).
   *
   * Needed only so the attachment dialogs can address the authorized content
   * and delete endpoints. It is never derived from a node attribute or any other
   * caller-supplied value, and tenant isolation itself stays server-side.
   * Absent disables the attachment dialogs rather than guessing a workspace.
   */
  readonly workspaceId?: string;
  /** Loaded attachment metadata, used only to render existing images. */
  readonly attachmentDirectory?: AttachmentDirectory | null;
  /**
   * Part 58 seam. Absent or `null` is the solo editor every earlier part was
   * written against. A binding is captured once per instance and never swapped:
   * the host (`NoteEditorSurface`) remounts this component with a new `key` when
   * the mode changes, so one instance is either collaborative or solo for its
   * whole life. This component still performs no I/O — the socket, the sync
   * protocol, and awareness all belong to the binding's owner.
   */
  readonly collaboration?: NoteCollaborationBinding | null;
  /**
   * Part 58 fallback, and the ONE thing about a collaborative instance that is
   * allowed to change after creation.
   *
   * A live session whose realtime writes have failed for good hands the pen back
   * to the Part 39 autosave IN PLACE. It is not remounted into solo mode,
   * because this instance's content lives in the shared `Y.Doc` and a remount
   * would reload the note as it was when the page opened — losing everything
   * typed since. Set only by that path; a healthy collaborative editor drives no
   * autosave at all, and a solo one ignores this entirely.
   */
  readonly collaborationWriteFailed?: boolean;
  /**
   * Part 60 seam. Anchored comment threads to highlight, read at redraw time so
   * a new comment list never rebuilds the editor. Absent registers no plugin at
   * all — the extension list is then byte-identical to every earlier part — and
   * the host calls `refreshCommentDecorations` when the list changes.
   */
  readonly resolveComments?: () => readonly CommentAnchorTarget[];
  /** Part 60 seam: the thread the reader currently has open, or `null`. */
  readonly resolveActiveCommentId?: () => string | null;
}

type PreparedDocument =
  | { readonly ok: true; readonly document: NoteDocument; readonly migrated: boolean }
  | { readonly ok: false; readonly message: string };

const DEFAULT_READ_ONLY_REASON =
  "You do not have permission to edit this note, so it is shown read only.";

function prepare(input: unknown): PreparedDocument {
  try {
    const result = prepareNoteDocumentForEditor(input);
    return { ok: true, document: result.doc, migrated: result.migrated };
  } catch {
    // The shared contract could not recover this document. Never fall back to
    // rendering the raw value: show a safe error state instead.
    return {
      ok: false,
      message:
        "This note's stored content could not be validated, so the editor was not opened. No content was changed.",
    };
  }
}

/**
 * Project an incoming document through the editor's schema so default
 * attributes are filled in. Without this, a contract document and the editor's
 * own serialization always differ, and the reconciliation effect would replace
 * the content — and reset the cursor — on every render.
 */
function schemaNormalized(editor: Editor, document: NoteDocument): unknown {
  try {
    return editor.schema.nodeFromJSON(document).toJSON();
  } catch {
    return document;
  }
}

/**
 * Client boundary for note editing.
 *
 * Part 34 keeps all state local: the editor never talks to the server. Callers
 * observe changes through `onDocumentChange` (Part 39 owns persistence).
 */
export function TiptapEditor({
  initialDocument,
  editable,
  noteId,
  ariaLabel,
  readOnlyReason,
  onDocumentChange,
  onDocumentRejected,
  onEditorReady,
  mentionSearch,
  mentionDirectory,
  mentionDirectoryTruncated,
  uploadImages,
  onRequestImageFiles,
  uploadAttachments,
  onRequestAttachmentFiles,
  workspaceId,
  attachmentDirectory,
  collaboration,
  collaborationWriteFailed,
  resolveComments,
  resolveActiveCommentId,
}: TiptapEditorProps) {
  const prepared = useMemo(() => prepare(initialDocument), [initialDocument]);

  if (!prepared.ok) {
    return (
      <div className="notted-editor space-y-3" data-note-id={noteId}>
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
          {prepared.message}
        </p>
      </div>
    );
  }

  return (
    <EditorSurface
      noteDocument={prepared.document}
      migrated={prepared.migrated}
      editable={editable}
      noteId={noteId}
      ariaLabel={ariaLabel}
      readOnlyReason={readOnlyReason}
      onDocumentChange={onDocumentChange}
      onDocumentRejected={onDocumentRejected}
      onEditorReady={onEditorReady}
      mentionSearch={mentionSearch}
      mentionDirectory={mentionDirectory}
      mentionDirectoryTruncated={mentionDirectoryTruncated}
      uploadImages={uploadImages}
      onRequestImageFiles={onRequestImageFiles}
      uploadAttachments={uploadAttachments}
      onRequestAttachmentFiles={onRequestAttachmentFiles}
      workspaceId={workspaceId}
      attachmentDirectory={attachmentDirectory}
      collaboration={collaboration}
      collaborationWriteFailed={collaborationWriteFailed}
      resolveComments={resolveComments}
      resolveActiveCommentId={resolveActiveCommentId}
    />
  );
}

interface EditorSurfaceProps {
  readonly noteDocument: NoteDocument;
  readonly migrated: boolean;
  readonly editable: boolean;
  readonly noteId: string;
  readonly ariaLabel?: string;
  readonly readOnlyReason?: string;
  readonly onDocumentChange?: (document: NoteDocument) => void;
  readonly onDocumentRejected?: (rejected: boolean) => void;
  readonly onEditorReady?: (editor: Editor | null) => void;
  readonly mentionSearch?: (query: string) => Promise<readonly MentionCandidate[]>;
  readonly mentionDirectory?: MentionDirectory | null;
  readonly mentionDirectoryTruncated?: boolean;
  readonly uploadImages?: ImageUploadHandler;
  readonly onRequestImageFiles?: ImageFilePickerHandler;
  readonly uploadAttachments?: AttachmentUploadHandler;
  readonly onRequestAttachmentFiles?: AttachmentFilePickerHandler;
  readonly workspaceId?: string;
  readonly attachmentDirectory?: AttachmentDirectory | null;
  readonly collaboration?: NoteCollaborationBinding | null;
  readonly collaborationWriteFailed?: boolean;
  readonly resolveComments?: () => readonly CommentAnchorTarget[];
  readonly resolveActiveCommentId?: () => string | null;
}

function EditorSurface({
  noteDocument,
  migrated,
  editable,
  noteId,
  ariaLabel,
  readOnlyReason,
  onDocumentChange,
  onDocumentRejected,
  onEditorReady,
  mentionSearch,
  mentionDirectory,
  mentionDirectoryTruncated = false,
  uploadImages,
  onRequestImageFiles,
  uploadAttachments,
  onRequestAttachmentFiles,
  workspaceId,
  attachmentDirectory,
  collaboration,
  collaborationWriteFailed = false,
  resolveComments,
  resolveActiveCommentId,
}: EditorSurfaceProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [outputRejected, setOutputRejected] = useState(false);
  const slashMenu = useSuggestionPopup<SlashCommand>();
  const mentionMenu = useSuggestionPopup<MentionCandidate>();
  // A page-wide viewing mode shared with `PageContainer`, which owns the toggle
  // button, the announcement, and clearing the mode on unmount.
  const focusMode = useFocusMode();
  /*
   * Subscribed to, deliberately not read.
   *
   * The "Continue writing with AI" toolbar item's `isAvailable` asks the module
   * store directly (`isAiContinueAvailable()`), so nothing in this render tree
   * depends on a value React can see change. Without this subscription the
   * button would keep whatever availability it had when the toolbar last
   * rendered for some other reason — offered while no panel can serve it, or
   * greyed out after one mounted. This is exactly why `useFocusMode()` above is
   * called here too: the subscription, not the value, is the point.
   */
  useAiContinueAvailable();
  /**
   * The floating toolbar has to leave this subtree.
   *
   * `PageContainer`'s paper always carries a transform (`translateX(-50%)`, plus
   * the zoom scale), and a transformed ancestor becomes the containing block for
   * every `position: fixed` descendant. A toolbar rendered in place would
   * therefore be positioned against — and scaled with — the sheet instead of
   * floating over the viewport. Portalling to `document.body` is the only way
   * out; the React tree, and so the roving tab index and every dialog, is
   * unaffected. Resolved after mount so the server render stays identical.
   */
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  // Latest values are read through refs so changing a callback or the editable
  // flag never rebuilds the editor and never discards editing history.
  const changeRef = useRef(onDocumentChange);
  changeRef.current = onDocumentChange;
  const rejectedRef = useRef(onDocumentRejected);
  rejectedRef.current = onDocumentRejected;
  const readyRef = useRef(onEditorReady);
  readyRef.current = onEditorReady;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const editorRef = useRef<Editor | null>(null);
  const handlersRef = useRef<EditorShortcutHandlerMap>({});
  handlersRef.current = {
    insertLink: () => {
      if (!editableRef.current) return false;
      setLinkDialogOpen(true);
      return true;
    },
    openSlashMenu: () => {
      const instance = editorRef.current;
      if (!editableRef.current || instance === null) return false;
      return openSlashMenuAtCaret(instance);
    },
    insertMention: () => {
      const instance = editorRef.current;
      if (!editableRef.current || instance === null) return false;
      return openMentionMenuAtCaret(instance);
    },
    insertPageBreak: () => {
      const instance = editorRef.current;
      if (!editableRef.current || instance === null) return false;
      return instance.chain().focus().setPageBreak().run();
    },
    // Reading a note in focus mode needs no write permission, so this one is
    // deliberately not gated on `editable`.
    toggleFocusMode: () => toggleFocusMode(),
    /*
     * Part 68. Gated on `editable` because a continuation writes into the note;
     * `false` here (and `false` from an unregistered panel) reports the key as
     * unhandled, so `Mod-Enter` falls through to HardBreak rather than being
     * swallowed. No editor instance is passed: the panel already holds the live
     * editor, and it reads the caret's surroundings itself at press time.
     */
    requestAiContinue: () => {
      if (!editableRef.current) return false;
      return requestAiContinue();
    },
  };

  // The document the editor was created with. Later documents arrive through
  // the reconciliation effect below rather than by rebuilding the editor.
  const initialContentRef = useRef<NoteDocument>(noteDocument);

  // The popups' sinks and the injected search are read through refs at call
  // time, so neither React state nor a changed callback rebuilds the editor.
  const slashSinkRef = useRef(slashMenu.sink);
  slashSinkRef.current = slashMenu.sink;
  const mentionSinkRef = useRef(mentionMenu.sink);
  mentionSinkRef.current = mentionMenu.sink;
  const mentionSearchRef = useRef(mentionSearch);
  mentionSearchRef.current = mentionSearch;
  // The directory is a mutable observable by design, so the first one is kept
  // for the lifetime of the editor: swapping it would mean rebuilding the
  // editor and discarding editing history.
  const mentionDirectoryRef = useRef(mentionDirectory ?? null);

  // Part 42 follows the identical rule: the upload host and the file-picker
  // opener are read through refs at call time, so a host that re-renders with a
  // new callback never rebuilds the editor and never discards editing history.
  // Neither is ever captured by the `useMemo(…, [])` extension list below.
  const uploadImagesRef = useRef(uploadImages);
  uploadImagesRef.current = uploadImages;
  const requestImageFilesRef = useRef(onRequestImageFiles);
  requestImageFilesRef.current = onRequestImageFiles;
  // Part 44 uses the identical ref discipline, for the identical reason.
  const uploadAttachmentsRef = useRef(uploadAttachments);
  uploadAttachmentsRef.current = uploadAttachments;
  const requestAttachmentFilesRef = useRef(onRequestAttachmentFiles);
  requestAttachmentFilesRef.current = onRequestAttachmentFiles;
  // A mutable observable, kept for the editor's lifetime for the same reason as
  // the mention directory: swapping it would mean rebuilding the editor.
  const attachmentDirectoryRef = useRef(attachmentDirectory ?? null);

  // Part 58, and the one ref that is deliberately never refreshed from props:
  // whether this instance is collaborative decides which plugins exist, which
  // document owns the content, and whether autosave is driven at all. Fixing it
  // at creation is what makes "one mode per editor instance" true rather than
  // aspirational; the host remounts with a new `key` to change it.
  const collaborationRef = useRef(collaboration ?? null);
  // The exception to the rule above, and the only one: whether realtime has
  // stopped taking this session's writes changes mid-session, so it is read
  // through a ref at transaction time rather than captured at creation. It
  // changes no plugin and no document ownership — only who is told about a
  // change — so it is not a remount.
  const collaborationWriteFailedRef = useRef(collaborationWriteFailed);
  collaborationWriteFailedRef.current = collaborationWriteFailed;

  // Part 60 follows the Part 42/44 ref discipline exactly: the comment list and
  // the open thread are read through refs at redraw time, so a host that
  // re-renders with a new list never rebuilds the editor. Whether the plugin
  // exists at all is decided once, from the props this instance was created
  // with, for the same reason `collaborationRef` is: it changes which plugins
  // are installed, and that is a remount, not a prop update.
  const resolveCommentsRef = useRef(resolveComments);
  resolveCommentsRef.current = resolveComments;
  const resolveActiveCommentIdRef = useRef(resolveActiveCommentId);
  resolveActiveCommentIdRef.current = resolveActiveCommentId;
  const commentsEnabledRef = useRef(resolveComments !== undefined);

  const extensions = useMemo(
    () => [
      ...createNoteEditorExtensions({
        resolveSlashSink: () => slashSinkRef.current,
        resolveMentionSink: () => mentionSinkRef.current,
        searchMentions: async (query) => (await mentionSearchRef.current?.(query)) ?? [],
        mentionDirectory: mentionDirectoryRef.current,
        attachmentDirectory: attachmentDirectoryRef.current,
        resolveImageUploader: () => uploadImagesRef.current ?? null,
        resolveImageFilePicker: () => requestImageFilesRef.current ?? null,
        resolveAttachmentUploader: () => uploadAttachmentsRef.current ?? null,
        resolveAttachmentFilePicker: () => requestAttachmentFilesRef.current ?? null,
        collaboration: collaborationRef.current,
        // Spread rather than passed as `undefined`: `createNoteEditorExtensions`
        // appends the decoration extension only when the key is defined, so a
        // host that never comments produces the pre-Part-60 extension list.
        ...(commentsEnabledRef.current
          ? {
              resolveComments: () => resolveCommentsRef.current?.() ?? [],
              resolveActiveCommentId: () => resolveActiveCommentIdRef.current?.() ?? null,
            }
          : {}),
      }),
      EditorShortcuts.configure({ resolveHandlers: () => handlersRef.current }),
    ],
    [],
  );

  const handleUpdate = useCallback((instance: Editor): void => {
    /*
     * Part 58. In collaborative mode every remote transaction would re-run the
     * contract check here and toggle `outputRejected` for content this writer
     * never typed, and autosave is not bound to this editor at all. The contract
     * guard moves server-side to the projection, which is the only writer of
     * `notes.content` while a collaborative session is live.
     */
    /*
     * The exception is a collaborative session whose realtime writes have
     * failed: autosave is then the only writer left, so the contract check has
     * to run and the change has to be reported. Nothing else re-enables it —
     * merely being handed an `onDocumentChange` does not, because the host
     * passes one throughout and the flag is what changes.
     */
    if (collaborationRef.current !== null && !collaborationWriteFailedRef.current) return;
    const json: unknown = instance.getJSON();
    const parsed = safeParseNoteDocument(json);
    if (!parsed.success) {
      setOutputRejected(true);
      // Reported, never swallowed: `onDocumentChange` is not called for this
      // transaction, so autosave has to learn that saving has stopped rather
      // than sit quietly on the previous document (Part 39).
      rejectedRef.current?.(true);
      return;
    }
    setOutputRejected(false);
    rejectedRef.current?.(false);
    changeRef.current?.(parsed.doc);
  }, []);

  const editor = useEditor({
    extensions,
    /*
     * Part 58. Content is seeded here only in solo mode. Passing `content`
     * alongside `Collaboration` appends the whole document into the shared type
     * a second time — every peer would gain a duplicated copy of the note. That
     * is data corruption, not a style preference; the Y.Doc is the sole source
     * of content for a collaborative instance.
     */
    content: collaborationRef.current === null ? initialContentRef.current : undefined,
    editable,
    // Next.js renders this component on the server first; deferring the first
    // ProseMirror render avoids a hydration mismatch.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel ?? DEFAULT_ARIA_LABEL,
        class: "notted-editor-content",
      },
    },
    onUpdate: ({ editor: instance }) => handleUpdate(instance),
  });

  editorRef.current = editor;

  useEffect(() => {
    if (editor === null) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // Reconcile an updated document without clobbering in-progress editing:
  // only replace the content when it genuinely differs from what is loaded.
  useEffect(() => {
    if (editor === null) return;
    // Part 58. `setContent` replaces the whole document, which in collaborative
    // mode would be broadcast to every peer as a delete-and-reinsert of the
    // note. Reconciliation belongs to Yjs there; a server-side change arrives as
    // an update on the shared document, not as a new prop.
    if (collaborationRef.current !== null) return;
    if (areDocumentsEquivalent(schemaNormalized(editor, noteDocument), editor.getJSON())) return;
    editor.commands.setContent(noteDocument, false);
  }, [editor, noteDocument]);

  useEffect(() => {
    readyRef.current?.(editor);
    // `useEditor` destroys the instance on unmount; report the teardown so
    // consumers (Part 39 autosave) can drop their reference.
    return () => readyRef.current?.(null);
  }, [editor]);

  // In focus mode the same component renders a reduced group table. It is never
  // a second toolbar: swapping `groups` keeps one roving tab index, one set of
  // dialogs, and one source of truth for every command.
  const floating = focusMode && portalTarget !== null;
  const toolbar = (
    <EditorToolbar
      editor={editor}
      editable={editable}
      groups={floating ? FOCUS_TOOLBAR_GROUPS : undefined}
      onOpenShortcuts={() => setShortcutsOpen(true)}
      linkDialogOpen={linkDialogOpen}
      onLinkDialogOpenChange={setLinkDialogOpen}
    />
  );

  return (
    <div className="notted-editor space-y-3" data-note-id={noteId}>
      {/*
       * These notices are application chrome, not note content, so they carry
       * `data-notted-print-hide`. Without it a read-only note prints "You can
       * read this note, but you do not have permission to edit it." into the
       * PDF, which breaks Part 38's "only note content" criterion.
       */}
      {migrated ? (
        <p
          role="status"
          data-notted-print-hide
          className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
        >
          This note used an older content format and was repaired for editing. Nothing was saved
          automatically.
        </p>
      ) : null}
      {editable ? null : (
        <p
          role="note"
          data-notted-print-hide
          className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
        >
          {readOnlyReason ?? DEFAULT_READ_ONLY_REASON}
        </p>
      )}
      {focusMode && portalTarget !== null
        ? createPortal(<div className="notted-focus-toolbar">{toolbar}</div>, portalTarget)
        : toolbar}
      {/*
       * One event, one assertive announcement.
       *
       * When a host is listening on `onDocumentRejected` — the note page is,
       * through `NoteSaveProvider` — it renders the save-scoped alert in
       * `SaveStatusIndicator`, which states the actionable consequence: nothing
       * will save until the change is undone. Rendering this one as well would
       * queue two overlapping assertive messages for the same rejection, so it
       * is kept only for a standalone editor with no autosave host, where it
       * would otherwise be the sole report.
       */}
      {outputRejected && onDocumentRejected === undefined ? (
        <p
          role="alert"
          data-notted-print-hide
          className="rounded-md border border-destructive/40 p-3 text-sm"
        >
          The last change produced content the note contract rejects and was not reported to the
          document. Undo the change and try again.
        </p>
      ) : null}
      <EditorContent editor={editor} />
      <SlashCommandMenu
        editor={editor}
        state={slashMenu.state}
        onSelect={slashMenu.select}
        onActivate={slashMenu.setActiveIndex}
        onDismiss={slashMenu.dismiss}
      />
      <MentionList
        editor={editor}
        state={mentionMenu.state}
        truncated={mentionDirectoryTruncated}
        onSelect={mentionMenu.select}
        onActivate={mentionMenu.setActiveIndex}
        onDismiss={mentionMenu.dismiss}
      />
      {/*
       * Part 43. Contextual chrome for the selected image. It portals itself to
       * `document.body` for the same reason the focus-mode toolbar does — the
       * paper's transform would otherwise become its containing block — and it
       * renders nothing at all unless a `NodeSelection` is on an image.
       */}
      <ImageToolbar editor={editor} editable={editable} portalTarget={portalTarget} />
      {/*
       * Part 44. The React owner of the attachment card's two dialogs. It
       * renders nothing until the card raises `notted:attachment-preview` or
       * `notted:attachment-remove` on `editor.view.dom`, which is what keeps
       * every dialog, fetch, and piece of React state out of the editor's own
       * subtree. Without a workspace it is not rendered at all rather than
       * guessing which workspace to address.
       */}
      {workspaceId === undefined ? null : (
        <AttachmentDialogs
          editor={editor}
          workspaceId={workspaceId}
          editable={editable}
          attachmentDirectory={attachmentDirectoryRef.current}
        />
      )}
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
