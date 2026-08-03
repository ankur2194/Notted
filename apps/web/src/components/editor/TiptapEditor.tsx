"use client";

import { safeParseNoteDocument, type NoteDocument } from "@notted/shared-validators";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { prepareNoteDocumentForEditor } from "./document-contract";
import { areDocumentsEquivalent } from "./document-sync";
import { EditorToolbar } from "./EditorToolbar";
import { EditorShortcuts, type EditorShortcutHandlerMap } from "./extensions/editor-shortcuts";
import { createNoteEditorExtensions } from "./extensions/note-editor-extensions";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { MentionList } from "./MentionList";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { openMentionMenuAtCaret, openSlashMenuAtCaret } from "./suggestion-triggers";
import { useSuggestionPopup } from "./useSuggestionPopup";

import type { MentionCandidate, MentionDirectory } from "./mention-members";
import type { SlashCommand } from "./slash-commands";
import type { Editor } from "@tiptap/core";

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
  onEditorReady,
  mentionSearch,
  mentionDirectory,
  mentionDirectoryTruncated,
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
      onEditorReady={onEditorReady}
      mentionSearch={mentionSearch}
      mentionDirectory={mentionDirectory}
      mentionDirectoryTruncated={mentionDirectoryTruncated}
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
  readonly onEditorReady?: (editor: Editor | null) => void;
  readonly mentionSearch?: (query: string) => Promise<readonly MentionCandidate[]>;
  readonly mentionDirectory?: MentionDirectory | null;
  readonly mentionDirectoryTruncated?: boolean;
}

function EditorSurface({
  noteDocument,
  migrated,
  editable,
  noteId,
  ariaLabel,
  readOnlyReason,
  onDocumentChange,
  onEditorReady,
  mentionSearch,
  mentionDirectory,
  mentionDirectoryTruncated = false,
}: EditorSurfaceProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [outputRejected, setOutputRejected] = useState(false);
  const slashMenu = useSuggestionPopup<SlashCommand>();
  const mentionMenu = useSuggestionPopup<MentionCandidate>();

  // Latest values are read through refs so changing a callback or the editable
  // flag never rebuilds the editor and never discards editing history.
  const changeRef = useRef(onDocumentChange);
  changeRef.current = onDocumentChange;
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

  const extensions = useMemo(
    () => [
      ...createNoteEditorExtensions({
        resolveSlashSink: () => slashSinkRef.current,
        resolveMentionSink: () => mentionSinkRef.current,
        searchMentions: async (query) => (await mentionSearchRef.current?.(query)) ?? [],
        mentionDirectory: mentionDirectoryRef.current,
      }),
      EditorShortcuts.configure({ resolveHandlers: () => handlersRef.current }),
    ],
    [],
  );

  const handleUpdate = useCallback((instance: Editor): void => {
    const json: unknown = instance.getJSON();
    const parsed = safeParseNoteDocument(json);
    if (!parsed.success) {
      setOutputRejected(true);
      return;
    }
    setOutputRejected(false);
    changeRef.current?.(parsed.doc);
  }, []);

  const editor = useEditor({
    extensions,
    content: initialContentRef.current,
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
    if (areDocumentsEquivalent(schemaNormalized(editor, noteDocument), editor.getJSON())) return;
    editor.commands.setContent(noteDocument, false);
  }, [editor, noteDocument]);

  useEffect(() => {
    readyRef.current?.(editor);
    // `useEditor` destroys the instance on unmount; report the teardown so
    // consumers (Part 39 autosave) can drop their reference.
    return () => readyRef.current?.(null);
  }, [editor]);

  return (
    <div className="notted-editor space-y-3" data-note-id={noteId}>
      {migrated ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          This note used an older content format and was repaired for editing. Nothing was saved
          automatically.
        </p>
      ) : null}
      {editable ? null : (
        <p role="note" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {readOnlyReason ?? DEFAULT_READ_ONLY_REASON}
        </p>
      )}
      <EditorToolbar
        editor={editor}
        editable={editable}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        linkDialogOpen={linkDialogOpen}
        onLinkDialogOpenChange={setLinkDialogOpen}
      />
      {outputRejected ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
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
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
