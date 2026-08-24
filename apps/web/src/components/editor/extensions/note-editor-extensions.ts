import { normalizeNoteDocumentCodeLanguage, sanitizeDocumentUrl } from "@notted/shared-validators";
import { Node, textblockTypeInputRule, type Extensions } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCursor } from "@tiptap/extension-collaboration-cursor";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { StarterKit } from "@tiptap/starter-kit";

import { createNoteLowlight } from "./code-block-languages";
import { createCommentDecorations } from "./comment-decorations";
import { createNoteAttachment } from "./CustomAttachment";
import { createNoteImage } from "./CustomImage";
import { FontSize } from "./font-size";
import { createGrammarDecorations } from "./grammar-decorations";
import { createNoteMention } from "./Mention";
import { NoteBlockTab } from "./note-block-tab";
import { createPageBreakExtension } from "./page-break";
import { createNoteSlashCommand } from "./slash-command";

import type { AttachmentDirectory } from "../attachment-directory";
import type { MentionCandidate, MentionDirectory } from "../mention-members";
import type { SlashCommand } from "../slash-commands";
import type { SuggestionSink } from "../suggestion-popup";
import type { CommentAnchorTarget } from "./comment-decorations";
import type { AttachmentFilePickerHandler, AttachmentUploadHandler } from "./CustomAttachment";
import type { ImageFilePickerHandler, ImageUploadHandler } from "./CustomImage";
import type { GrammarSuggestionTarget } from "./grammar-decorations";
import type { NoteCollaborationBinding } from "@/lib/collaboration/note-collaboration-provider";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { DecorationAttrs } from "@tiptap/pm/view";

/** Exact copy required by the product brief for an empty note. */
export const NOTE_EDITOR_PLACEHOLDER = "Start writing...";

const SAFE_LINK_REL = "noopener noreferrer nofollow";
const NoteDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "block*",
});

/** Markdown fences: ```` ```ts ```` and `~~~ts`, plus the unlabelled forms. */
const BACKTICK_CODE_BLOCK_REGEX = /^```([a-z]+)?[\s\n]$/;
const TILDE_CODE_BLOCK_REGEX = /^~~~([a-z]+)?[\s\n]$/;

function createSafeLinkExtension() {
  return Link.extend({
    // Persist exactly the link attributes accepted by the shared contract.
    addAttributes() {
      return {
        href: {
          default: null,
          parseHTML: (element: HTMLElement) => sanitizeDocumentUrl(element.getAttribute("href")),
        },
        target: {
          default: "_blank",
          parseHTML: () => "_blank",
        },
        rel: {
          default: SAFE_LINK_REL,
          parseHTML: () => SAFE_LINK_REL,
        },
        class: {
          default: null,
          parseHTML: () => null,
        },
      };
    },
  }).configure({
    openOnClick: false,
    HTMLAttributes: {
      rel: SAFE_LINK_REL,
      target: "_blank",
    },
    validate: (url) => sanitizeDocumentUrl(url) !== null,
    isAllowedUri: (url) => sanitizeDocumentUrl(url) !== null,
    shouldAutoLink: (url) => sanitizeDocumentUrl(url) !== null,
  });
}

/**
 * Syntax-highlighted code blocks bounded by the shared language registry.
 *
 * Highlighting itself only produces decorations, so the persisted JSON is
 * unchanged by it. The `language` attribute is the part that persists, so both
 * ways it can be set from untrusted input — a markdown fence and a pasted
 * `language-*` class — are normalized to a registered language or `null`.
 */
function createCodeBlockExtension() {
  return CodeBlockLowlight.extend({
    addAttributes() {
      return {
        language: {
          default: null,
          rendered: false,
          parseHTML: (element: HTMLElement) => {
            const classNames = [...(element.firstElementChild?.classList ?? [])];
            const declared = classNames.find((name) => name.startsWith("language-"));
            return normalizeNoteDocumentCodeLanguage(declared?.slice("language-".length));
          },
        },
      };
    },
    addInputRules() {
      return [BACKTICK_CODE_BLOCK_REGEX, TILDE_CODE_BLOCK_REGEX].map((find) =>
        textblockTypeInputRule({
          find,
          type: this.type,
          getAttributes: (match) => ({ language: normalizeNoteDocumentCodeLanguage(match[1]) }),
        }),
      );
    },
  }).configure({
    lowlight: createNoteLowlight(),
    defaultLanguage: null,
    // `language-*` is still emitted on export; only the attribute is constrained.
    languageClassPrefix: "language-",
  });
}

/**
 * Accessible name for a checklist checkbox.
 *
 * TipTap's default uses the whole item's text, so a parent item announces its
 * nested children's text too. Only the item's own first block is used here, and
 * the checked state is left to the checkbox role rather than duplicated in the
 * name.
 */
export function taskItemCheckboxLabel(node: ProseMirrorNode): string {
  const own = node.firstChild?.textContent.trim() ?? "";
  return own.length === 0 ? "Empty task item checkbox" : `Task item checkbox for ${own}`;
}

function labelTaskItemCheckbox(dom: HTMLElement, node: ProseMirrorNode): void {
  const checkbox = dom.querySelector('input[type="checkbox"]');
  if (checkbox instanceof HTMLInputElement) {
    checkbox.setAttribute("aria-label", taskItemCheckboxLabel(node));
  }
}

/**
 * Checklist items with a checkbox name that stays correct.
 *
 * TipTap 2.27.1 computes the checkbox's accessible name once and refreshes it
 * from the node captured when the node view was created, so an item typed into
 * after creation keeps announcing "empty task item" (WCAG 2.2 SC 4.1.2). The
 * node view is wrapped here to relabel the checkbox on every update.
 */
function createTaskItemExtension() {
  return TaskItem.extend({
    addNodeView() {
      const renderStockNodeView = this.parent?.();
      if (renderStockNodeView === undefined) {
        throw new Error("TaskItem node view is unavailable");
      }
      return (props) => {
        const view = renderStockNodeView(props);
        const dom = view.dom;
        if (!(dom instanceof HTMLElement)) return view;
        labelTaskItemCheckbox(dom, props.node);
        const stockUpdate = view.update?.bind(view);
        return {
          ...view,
          update: (node, decorations, innerDecorations) => {
            const handled =
              stockUpdate === undefined ? false : stockUpdate(node, decorations, innerDecorations);
            if (handled) labelTaskItemCheckbox(dom, node);
            return handled;
          },
        };
      };
    },
  }).configure({ nested: true, a11y: { checkboxLabel: taskItemCheckboxLabel } });
}

/**
 * Tables whose only Tab authority is `NoteBlockTab`.
 *
 * The stock Table keymap binds Tab to "next cell, else `addRowAfter`". A higher
 * priority only decides who runs *first*: when `NoteBlockTab` declines Tab at a
 * contract bound it returns `false`, and ProseMirror then offers the same key to
 * this lower-priority keymap, which would add the row anyway. Removing exactly
 * those two bindings makes declining meaningful and leaves Tab free to reach the
 * browser, so the growth guard holds without introducing a keyboard trap.
 *
 * Only Tab and Shift+Tab are dropped; the extension's Backspace/Delete
 * "delete the table when every cell is selected" bindings are kept as-is.
 */
function createTableExtension() {
  return Table.extend({
    addKeyboardShortcuts() {
      const inherited = this.parent?.() ?? {};
      return Object.fromEntries(
        Object.entries(inherited).filter(
          ([binding]) => binding !== "Tab" && binding !== "Shift-Tab",
        ),
      );
    },
  }).configure({ resizable: true, allowTableNodeSelection: false });
}

/**
 * Per-editor wiring for the Part 36 suggestion popups.
 *
 * Every field is optional so `createNoteEditorExtensions()` still builds the
 * complete schema — including the `mention` node — for schema round-trip tests
 * and for any caller that does not need live suggestions.
 */
export interface NoteEditorExtensionOptions {
  readonly resolveSlashSink?: () => SuggestionSink<SlashCommand> | null;
  readonly resolveMentionSink?: () => SuggestionSink<MentionCandidate> | null;
  /**
   * Injected member lookup. The editor performs no network I/O of its own;
   * the caller supplies a workspace-scoped search (see `NoteEditorSurface`).
   */
  readonly searchMentions?: (query: string) => Promise<readonly MentionCandidate[]>;
  readonly mentionDirectory?: MentionDirectory | null;
  /**
   * Part 42. Every field is optional for the same reason the mention fields are:
   * `createNoteEditorExtensions()` must still build the complete schema —
   * including the `image` node — for schema round-trip tests and for any caller
   * that has no upload host. Without a host, paste and drop simply decline.
   */
  readonly attachmentDirectory?: AttachmentDirectory | null;
  readonly resolveImageUploader?: () => ImageUploadHandler | null;
  readonly resolveImageFilePicker?: () => ImageFilePickerHandler | null;
  /**
   * Part 44, optional for the same reason: the schema must still contain the
   * `attachment` node with no upload host attached, and without one paste and
   * drop of a non-image file simply decline.
   */
  readonly resolveAttachmentUploader?: () => AttachmentUploadHandler | null;
  readonly resolveAttachmentFilePicker?: () => AttachmentFilePickerHandler | null;
  /**
   * Part 58. Absent or `null` builds exactly the extension list every other part
   * was written against: local history, no Yjs plugins, no awareness. Present
   * hands the document over to Yjs for this editor's whole lifetime — the two
   * modes are never mixed inside one instance.
   */
  readonly collaboration?: NoteCollaborationBinding | null;
  /**
   * Part 60, and optional for the same reason every seam above is: absent means
   * the comment-decoration plugin is never registered and this editor builds the
   * byte-identical extension list it always has. Present, it is read at plugin
   * time on every redraw — a ref-backed getter keeps `TiptapEditor`'s
   * `useMemo(…, [])` extension list on empty dependencies, so a changed comment
   * list never rebuilds the editor.
   */
  readonly resolveComments?: () => readonly CommentAnchorTarget[];
  readonly resolveActiveCommentId?: () => string | null;
  /**
   * Part 70, optional for the same reason: absent means the grammar-decoration
   * plugin is never registered and this editor builds the byte-identical
   * extension list it always has. Present, it is read at plugin time on every
   * redraw, so a ref-backed getter keeps `TiptapEditor`'s `useMemo(…, [])`
   * extension list on empty dependencies and a changed suggestion list never
   * rebuilds the editor.
   */
  readonly resolveGrammarSuggestions?: () => readonly GrammarSuggestionTarget[];
}

/**
 * What `@tiptap/extension-collaboration-cursor` v2 actually consumes.
 *
 * Its own option is typed `any` because it was written for the Hocuspocus
 * provider; the plugin only ever reads `provider.awareness`, so the shape is
 * declared here instead of casting.
 */
interface AwarenessProvider {
  readonly awareness: NoteCollaborationBinding["awareness"];
}

/**
 * Above this many live cursors, the name chips stop being labels and start
 * being a wall of overlapping boxes across the paragraph the group is working
 * on. Past it the carets keep their colour and the names stay reachable, one
 * keystroke away, in the presence bar's viewer dialog (Part 59).
 */
const CURSOR_LABEL_LIMIT = 12;

/** The only colour values this editor will paint. */
const PRESENCE_COLOR_PATTERN = /^var\(--notted-presence-[0-7]\)$/;

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/**
 * `user.color` reaches this renderer from a *remote* peer's awareness state, so
 * it is matched against the palette rather than trusted: an arbitrary string
 * written into an inline style is a CSS injection. An unrecognised value falls
 * back to the first palette slot, which is still a legible caret.
 */
function paletteColor(value: string): string {
  return PRESENCE_COLOR_PATTERN.test(value) ? value : "var(--notted-presence-0)";
}

/**
 * The remote peer's selection tint.
 *
 * Configured for the same reason as `render`: the stock `selectionRender`
 * interpolates `user.color` straight into a `style` attribute, and that value is
 * another client's unvalidated awareness state. The colour goes through
 * `paletteColor` and is passed as a custom property, so the only thing that can
 * ever reach the style attribute is one of the eight palette slots.
 */
function createSelectionRenderer(): (user: Record<string, unknown>) => DecorationAttrs {
  return (user: Record<string, unknown>): DecorationAttrs => ({
    class: "notted-presence-selection",
    style: `--notted-presence-selection: ${paletteColor(readString(user, "color"))};`,
  });
}

/**
 * The caret and its name chip.
 *
 * `binding.awareness` is queried on every call and never captured, which is
 * exactly right: `CollaborationCursor` rebuilds its decorations on every
 * awareness change, so the size read here is always the current one and no
 * React state, ref, or extension dependency is needed to keep it fresh.
 */
function createCursorRenderer(
  binding: NoteCollaborationBinding,
): (user: Record<string, unknown>) => HTMLElement {
  return (user: Record<string, unknown>): HTMLElement => {
    const color = paletteColor(readString(user, "color"));
    const caret = document.createElement("span");
    caret.className = "notted-presence-caret";
    caret.style.borderLeftColor = color;
    // Carets are live-session chrome; a printed page must not show them.
    caret.setAttribute("data-notted-print-hide", "");
    /*
     * And a screen reader must not read them either. This element is spliced
     * INTO the contenteditable at the peer's cursor, so without this the name
     * chip below is announced in the middle of the sentence being read — "the
     * quick brown Ada Lovelace fox". The whole subtree is hidden with one
     * attribute: the caret is a coloured border and the chip is a name that is
     * already available to assistive technology from `PresenceBar`'s roster,
     * which is the surface designed to be read on demand.
     *
     * ponytail: `aria-hidden` only, deliberately no `contenteditable="false"`.
     * `y-prosemirror` ships its own cursor widget without it, and a
     * false-contenteditable island inside a contenteditable has its own
     * caret-navigation quirks per browser. Upgrade path: add it if a peer's
     * caret is ever observed capturing the local selection.
     */
    caret.setAttribute("aria-hidden", "true");

    const name = readString(user, "name");
    if (name !== "" && binding.awareness.getStates().size <= CURSOR_LABEL_LIMIT) {
      const label = document.createElement("span");
      label.className = "notted-presence-caret-label";
      label.style.backgroundColor = color;
      // A text node, never `innerHTML`: the name is another peer's input.
      label.append(document.createTextNode(name));
      caret.append(label);
    }

    return caret;
  };
}

/** Build an isolated schema configuration for each editor instance. */
export function createNoteEditorExtensions(options: NoteEditorExtensionOptions = {}): Extensions {
  const collaboration = options.collaboration ?? null;
  const resolveComments = options.resolveComments;
  const resolveGrammarSuggestions = options.resolveGrammarSuggestions;
  return [
    StarterKit.configure({
      document: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // Replaced by the lowlight-backed code block below.
      codeBlock: false,
      /*
       * Local ProseMirror history and Yjs history cannot both own undo: the
       * local one would revert a remote peer's change. Nothing else moves —
       * `@tiptap/extension-collaboration` v2 re-registers `undo`/`redo` as
       * commands with the same keymap, so the declared bindings in
       * `keyboard-shortcuts.ts` (`source: "tiptap"`, `handler: null`) and the
       * `toolbar-commands.ts` undo/redo gate keep working unchanged.
       */
      ...(collaboration === null ? {} : { history: false as const }),
    }),
    NoteDocument,
    Underline.configure({}),
    TextStyle.configure({}),
    TextAlign.configure({
      types: ["paragraph", "heading"],
      alignments: ["left", "center", "right", "justify"],
    }),
    Color.configure({ types: ["textStyle"] }),
    Highlight.configure({ multicolor: true }),
    Subscript.configure({}),
    Superscript.configure({}),
    createSafeLinkExtension(),
    createCodeBlockExtension(),
    TaskList.configure({}),
    // Nested checklists, the `[]`/`[ ]`/`[x]` input rule, the checkbox node
    // view, and Enter splitting all come from the stock extension. Tab and
    // Shift+Tab are owned by `NoteBlockTab`, which outranks this keymap.
    createTaskItemExtension(),
    createTableExtension(),
    // Part 38's explicit break. A stateless leaf atom, so it adds a node type to
    // the schema and nothing else; the keymap lives in `EDITOR_SHORTCUTS`.
    createPageBreakExtension(),
    TableRow.configure({}),
    TableHeader.configure({}),
    TableCell.configure({}),
    Placeholder.configure({ placeholder: NOTE_EDITOR_PLACEHOLDER }),
    NoteBlockTab,
    FontSize.configure({}),
    createNoteSlashCommand({ resolveSink: options.resolveSlashSink }),
    createNoteMention({
      resolveSink: options.resolveMentionSink,
      search: options.searchMentions,
      directory: options.mentionDirectory,
    }),
    // Part 42's block-level image atom. It also registers the upload-placeholder
    // decoration plugin and the paste/drop handlers, so `editorProps` in
    // `TiptapEditor` stays `attributes`-only.
    createNoteImage({
      directory: options.attachmentDirectory,
      resolveUploader: options.resolveImageUploader,
      resolveFilePicker: options.resolveImageFilePicker,
    }),
    /*
     * Part 44's generic file card. **Registered after `createNoteImage` on
     * purpose, and the order is load-bearing.**
     *
     * ProseMirror offers a drop or a paste to each plugin's `handleDrop` /
     * `handlePaste` in registration order and stops at the first that returns
     * `true`. The image plugin consumes any payload containing an image and
     * declines otherwise, so this one only ever sees payloads with no images in
     * them. Reversing the two would let the attachment plugin swallow an image
     * drop before the image path ever saw it.
     *
     * Both share one directory and one upload queue; only the pre-flight
     * bounds, the completion node type, and the picker's `accept` differ.
     */
    createNoteAttachment({
      directory: options.attachmentDirectory,
      resolveUploader: options.resolveAttachmentUploader,
      resolveFilePicker: options.resolveAttachmentFilePicker,
    }),
    /*
     * Part 60's inline comment highlights. Registered only when the host supplies
     * a comment list, so every existing caller — and every schema round-trip test
     * — builds the exact extension list it did before. The plugin contributes
     * decorations only: it adds no node, no mark, and nothing to `getJSON()`.
     */
    ...(resolveComments === undefined
      ? []
      : [
          createCommentDecorations({
            resolveComments,
            resolveActiveCommentId: options.resolveActiveCommentId,
          }),
        ]),
    /*
     * Part 70's grammar and style underlines. Registered on the same terms as
     * the comment highlights directly above — only when the host supplies a
     * suggestion list — and, like them, contributing decorations only: no node,
     * no mark, and nothing in `getJSON()`.
     *
     * Placed AFTER the comment decorations and BEFORE `Collaboration`: a comment
     * highlight is the older, more authoritative annotation, so its background
     * paints under the suggestion's underline rather than the reverse.
     */
    ...(resolveGrammarSuggestions === undefined
      ? []
      : [createGrammarDecorations({ resolveGrammarSuggestions })]),
    /*
     * Part 58. Appended last and only when a binding exists, so a solo editor
     * builds the identical list it always has.
     *
     * `Collaboration` is used unwrapped and with no custom plugin key on
     * purpose: it must install `ySyncPlugin` under the DEFAULT `ySyncPluginKey`,
     * because Part 60 remaps comment anchors through
     * `ySyncPluginKey.getState(editor.state).binding`. A private abstraction or
     * a renamed key would silently break that lookup.
     *
     * `field: "default"` matches the API's `doc.getXmlFragment("default")`; the
     * two names are one contract and must never drift apart.
     */
    ...(collaboration === null
      ? []
      : [
          Collaboration.configure({ document: collaboration.document, field: "default" }),
          CollaborationCursor.configure({
            provider: { awareness: collaboration.awareness } satisfies AwarenessProvider,
            user: { name: collaboration.user.name, color: collaboration.user.color },
            // Part 59 replaces only the caret element. The extension itself
            // stays: it owns the awareness-to-decoration mapping, and a
            // hand-rolled `yCursorPlugin` would have to re-derive it.
            render: createCursorRenderer(collaboration),
            selectionRender: createSelectionRenderer(),
          }),
        ]),
  ];
}
