import { normalizeNoteDocumentCodeLanguage, sanitizeDocumentUrl } from "@notted/shared-validators";
import { Node, textblockTypeInputRule, type Extensions } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
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
import { createNoteImage } from "./CustomImage";
import { FontSize } from "./font-size";
import { createNoteMention } from "./Mention";
import { NoteBlockTab } from "./note-block-tab";
import { createPageBreakExtension } from "./page-break";
import { createNoteSlashCommand } from "./slash-command";

import type { AttachmentDirectory } from "../attachment-directory";
import type { MentionCandidate, MentionDirectory } from "../mention-members";
import type { SlashCommand } from "../slash-commands";
import type { SuggestionSink } from "../suggestion-popup";
import type { ImageFilePickerHandler, ImageUploadHandler } from "./CustomImage";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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
}

/** Build an isolated schema configuration for each editor instance. */
export function createNoteEditorExtensions(options: NoteEditorExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      document: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // Replaced by the lowlight-backed code block below.
      codeBlock: false,
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
  ];
}
