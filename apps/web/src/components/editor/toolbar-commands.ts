import { sanitizeDocumentUrl } from "@notted/shared-validators";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AtSign,
  Bold,
  Code,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  SquarePlus,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2,
} from "lucide-react";

// Side-effect imports: each of these declares the TipTap command signatures
// used below through module augmentation.
import "@tiptap/extension-color";
import "@tiptap/extension-highlight";
import "@tiptap/extension-link";
import "@tiptap/extension-subscript";
import "@tiptap/extension-superscript";
import "@tiptap/extension-table";
import "@tiptap/extension-task-list";
import "@tiptap/extension-text-align";
import "@tiptap/extension-underline";

import { isAllowedEditorColor } from "./editor-colors";
import { CODE_BLOCK_LANGUAGE_OPTIONS } from "./extensions/code-block-languages";
import { isAllowedNoteFontSize, type NoteFontSize } from "./extensions/font-size";
import {
  TABLE_COLUMN_WIDTH_STEP,
  adjustCurrentColumnWidth,
  isInTable,
  setCurrentColumnWidth,
} from "./extensions/table-column-width";
import {
  canAddTableColumn,
  canAddTableRow,
  canInsertTableOfSize,
  canSplitTableCell,
} from "./extensions/table-limits";
import { openMentionMenuAtCaret, openSlashMenuAtCaret } from "./suggestion-triggers";

import type { NoteDocumentCodeLanguage } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";

/**
 * Toolbar contents expressed as data so later parts can extend the toolbar
 * without touching its rendering, focus management, or accessibility wiring.
 *
 * Part 35/36 seam: append a group to `EDITOR_TOOLBAR_GROUPS`, or append items to
 * an existing group. `kind: "button"` items need no component changes at all;
 * `kind: "control"` items are rendered by a dedicated branch in
 * `EditorToolbar.tsx`.
 */

export type ToolbarControlKind =
  | "blockType"
  | "fontSize"
  | "textColor"
  | "highlightColor"
  | "link"
  | "codeLanguage"
  | "table"
  | "shortcuts";

export interface ToolbarButtonCommand {
  readonly kind: "button";
  readonly id: string;
  /** Accessible name; also used verbatim as the tooltip text. */
  readonly label: string;
  readonly icon: LucideIcon;
  /** Id in `EDITOR_SHORTCUTS`; appended to the tooltip when present. */
  readonly shortcutId?: string;
  /** Present for toggles only. Drives `aria-pressed`. */
  readonly isActive?: (editor: Editor) => boolean;
  /** Present when the command can be genuinely unavailable (undo/redo). */
  readonly isAvailable?: (editor: Editor) => boolean;
  readonly run: (editor: Editor) => void;
}

export interface ToolbarControlCommand {
  readonly kind: "control";
  readonly id: string;
  readonly label: string;
  readonly control: ToolbarControlKind;
  readonly shortcutId?: string;
}

export type ToolbarCommand = ToolbarButtonCommand | ToolbarControlCommand;

export interface ToolbarGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly ToolbarCommand[];
}

export type BlockTypeValue =
  "paragraph" | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6";

export interface BlockTypeOption {
  readonly value: BlockTypeValue;
  readonly label: string;
}

export const BLOCK_TYPE_OPTIONS: readonly BlockTypeOption[] = Object.freeze([
  { value: "paragraph", label: "Paragraph" },
  { value: "heading1", label: "Heading 1" },
  { value: "heading2", label: "Heading 2" },
  { value: "heading3", label: "Heading 3" },
  { value: "heading4", label: "Heading 4" },
  { value: "heading5", label: "Heading 5" },
  { value: "heading6", label: "Heading 6" },
]);

const HEADING_LEVEL_BY_VALUE: Readonly<Record<BlockTypeValue, 1 | 2 | 3 | 4 | 5 | 6 | null>> = {
  paragraph: null,
  heading1: 1,
  heading2: 2,
  heading3: 3,
  heading4: 4,
  heading5: 5,
  heading6: 6,
};

export function isBlockTypeValue(value: string): value is BlockTypeValue {
  return Object.prototype.hasOwnProperty.call(HEADING_LEVEL_BY_VALUE, value);
}

/** Current block type for the selection, defaulting to paragraph. */
export function activeBlockType(editor: Editor): BlockTypeValue {
  for (const option of BLOCK_TYPE_OPTIONS) {
    const level = HEADING_LEVEL_BY_VALUE[option.value];
    if (level !== null && editor.isActive("heading", { level })) return option.value;
  }
  return "paragraph";
}

export function applyBlockType(editor: Editor, value: BlockTypeValue): void {
  const level = HEADING_LEVEL_BY_VALUE[value];
  if (level === null) {
    editor.chain().focus().setParagraph().run();
    return;
  }
  editor.chain().focus().setHeading({ level }).run();
}

/** Current font size for the selection, or `null` when the note default applies. */
export function activeFontSize(editor: Editor): NoteFontSize | null {
  const value: unknown = editor.getAttributes("textStyle").fontSize;
  return isAllowedNoteFontSize(value) ? value : null;
}

export function applyFontSize(editor: Editor, size: NoteFontSize | null): boolean {
  if (size === null) {
    editor.chain().focus().unsetFontSize().run();
    return true;
  }
  if (!isAllowedNoteFontSize(size)) return false;
  editor.chain().focus().setFontSize(size).run();
  return true;
}

export function activeTextColor(editor: Editor): string | null {
  const value: unknown = editor.getAttributes("textStyle").color;
  return isAllowedEditorColor(value) ? value : null;
}

export function applyTextColor(editor: Editor, color: string | null): boolean {
  if (color === null) {
    editor.chain().focus().unsetColor().run();
    return true;
  }
  if (!isAllowedEditorColor(color)) return false;
  editor.chain().focus().setColor(color).run();
  return true;
}

export function activeHighlightColor(editor: Editor): string | null {
  const value: unknown = editor.getAttributes("highlight").color;
  return isAllowedEditorColor(value) ? value : null;
}

export function applyHighlight(editor: Editor, color: string | null): boolean {
  if (color === null) {
    editor.chain().focus().unsetHighlight().run();
    return true;
  }
  if (!isAllowedEditorColor(color)) return false;
  editor.chain().focus().setHighlight({ color }).run();
  return true;
}

export function activeLinkHref(editor: Editor): string {
  const value: unknown = editor.getAttributes("link").href;
  return typeof value === "string" ? value : "";
}

/**
 * Apply a link only when the shared contract's sanitizer accepts it, and store
 * exactly the sanitized value. Returns false so the caller can show an error.
 */
export function applyLink(editor: Editor, href: string): boolean {
  const sanitized = sanitizeDocumentUrl(href);
  if (sanitized === null) return false;
  editor.chain().focus().extendMarkRange("link").setLink({ href: sanitized }).run();
  return true;
}

export function removeLink(editor: Editor): void {
  editor.chain().focus().extendMarkRange("link").unsetLink().run();
}

/** Language stored on the code block at the selection, or `null` for plain. */
export function activeCodeLanguage(editor: Editor): NoteDocumentCodeLanguage | null {
  const value: unknown = editor.getAttributes("codeBlock").language;
  return isAllowedCodeLanguage(value) ? value : null;
}

function isAllowedCodeLanguage(value: unknown): value is NoteDocumentCodeLanguage {
  return (
    typeof value === "string" &&
    CODE_BLOCK_LANGUAGE_OPTIONS.some((option) => option.value === value)
  );
}

/**
 * Set the code block's language, rejecting anything outside the registry so the
 * stored attribute always satisfies the shared contract.
 */
export function applyCodeLanguage(editor: Editor, language: string | null): boolean {
  if (!editor.isActive("codeBlock")) return false;
  if (language !== null && !isAllowedCodeLanguage(language)) return false;
  editor.chain().focus().updateAttributes("codeBlock", { language }).run();
  return true;
}

export interface TableAction {
  readonly id: string;
  readonly label: string;
  /** False disables the control rather than hiding it, so the menu stays stable. */
  readonly isAvailable: (editor: Editor) => boolean;
  readonly run: (editor: Editor) => void;
}

const DEFAULT_TABLE_ROWS = 3;
const DEFAULT_TABLE_COLUMNS = 3;

/**
 * Every table operation the toolbar exposes, expressed as data.
 *
 * The three width actions are the keyboard-accessible counterpart to TipTap's
 * pointer-only column drag handles; they write the same `colwidth` attribute.
 *
 * Every action that *grows* a table also asks `extensions/table-limits` whether
 * the shared contract still admits the result. A growth action at its bound
 * reports itself unavailable — so the control is visibly disabled rather than
 * silently doing nothing — and refuses the command as well.
 */
export const TABLE_ACTIONS: readonly TableAction[] = Object.freeze([
  {
    id: "insertTable",
    label: `Insert ${DEFAULT_TABLE_ROWS} by ${DEFAULT_TABLE_COLUMNS} table`,
    isAvailable: (editor) =>
      canInsertTableOfSize(editor, DEFAULT_TABLE_ROWS, DEFAULT_TABLE_COLUMNS) &&
      editor.can().insertTable({
        rows: DEFAULT_TABLE_ROWS,
        cols: DEFAULT_TABLE_COLUMNS,
        withHeaderRow: true,
      }),
    run: (editor) => {
      if (!canInsertTableOfSize(editor, DEFAULT_TABLE_ROWS, DEFAULT_TABLE_COLUMNS)) return;
      editor
        .chain()
        .focus()
        .insertTable({ rows: DEFAULT_TABLE_ROWS, cols: DEFAULT_TABLE_COLUMNS, withHeaderRow: true })
        .run();
    },
  },
  {
    id: "addRowBefore",
    label: "Add row above",
    isAvailable: (editor) => canAddTableRow(editor) && editor.can().addRowBefore(),
    run: (editor) => {
      if (!canAddTableRow(editor)) return;
      editor.chain().focus().addRowBefore().run();
    },
  },
  {
    id: "addRowAfter",
    label: "Add row below",
    isAvailable: (editor) => canAddTableRow(editor) && editor.can().addRowAfter(),
    run: (editor) => {
      if (!canAddTableRow(editor)) return;
      editor.chain().focus().addRowAfter().run();
    },
  },
  {
    id: "deleteRow",
    label: "Delete row",
    isAvailable: (editor) => editor.can().deleteRow(),
    run: (editor) => {
      editor.chain().focus().deleteRow().run();
    },
  },
  {
    id: "addColumnBefore",
    label: "Add column before",
    isAvailable: (editor) => canAddTableColumn(editor) && editor.can().addColumnBefore(),
    run: (editor) => {
      if (!canAddTableColumn(editor)) return;
      editor.chain().focus().addColumnBefore().run();
    },
  },
  {
    id: "addColumnAfter",
    label: "Add column after",
    isAvailable: (editor) => canAddTableColumn(editor) && editor.can().addColumnAfter(),
    run: (editor) => {
      if (!canAddTableColumn(editor)) return;
      editor.chain().focus().addColumnAfter().run();
    },
  },
  {
    id: "deleteColumn",
    label: "Delete column",
    isAvailable: (editor) => editor.can().deleteColumn(),
    run: (editor) => {
      editor.chain().focus().deleteColumn().run();
    },
  },
  {
    id: "mergeCells",
    label: "Merge selected cells",
    isAvailable: (editor) => editor.can().mergeCells(),
    run: (editor) => {
      editor.chain().focus().mergeCells().run();
    },
  },
  {
    id: "splitCell",
    label: "Split cell",
    isAvailable: (editor) => canSplitTableCell(editor) && editor.can().splitCell(),
    run: (editor) => {
      if (!canSplitTableCell(editor)) return;
      editor.chain().focus().splitCell().run();
    },
  },
  {
    id: "toggleHeaderRow",
    label: "Toggle header row",
    isAvailable: (editor) => editor.can().toggleHeaderRow(),
    run: (editor) => {
      editor.chain().focus().toggleHeaderRow().run();
    },
  },
  {
    id: "widenColumn",
    label: "Widen column",
    isAvailable: (editor) => isInTable(editor),
    run: (editor) => {
      adjustCurrentColumnWidth(editor, TABLE_COLUMN_WIDTH_STEP);
    },
  },
  {
    id: "narrowColumn",
    label: "Narrow column",
    isAvailable: (editor) => isInTable(editor),
    run: (editor) => {
      adjustCurrentColumnWidth(editor, -TABLE_COLUMN_WIDTH_STEP);
    },
  },
  {
    id: "resetColumnWidth",
    label: "Reset column width",
    isAvailable: (editor) => isInTable(editor),
    run: (editor) => {
      setCurrentColumnWidth(editor, null);
    },
  },
  {
    id: "deleteTable",
    label: "Delete table",
    isAvailable: (editor) => editor.can().deleteTable(),
    run: (editor) => {
      editor.chain().focus().deleteTable().run();
    },
  },
]);

function alignmentCommand(
  id: string,
  label: string,
  icon: LucideIcon,
  alignment: "left" | "center" | "right" | "justify",
  shortcutId: string,
): ToolbarButtonCommand {
  return {
    kind: "button",
    id,
    label,
    icon,
    shortcutId,
    isActive: (editor) => editor.isActive({ textAlign: alignment }),
    run: (editor) => {
      if (editor.isActive({ textAlign: alignment })) {
        editor.chain().focus().unsetTextAlign().run();
        return;
      }
      editor.chain().focus().setTextAlign(alignment).run();
    },
  };
}

export const EDITOR_TOOLBAR_GROUPS: readonly ToolbarGroup[] = Object.freeze([
  {
    id: "history",
    label: "History",
    items: [
      {
        kind: "button",
        id: "undo",
        label: "Undo",
        icon: Undo2,
        shortcutId: "undo",
        isAvailable: (editor) => editor.can().undo(),
        run: (editor) => {
          editor.chain().focus().undo().run();
        },
      },
      {
        kind: "button",
        id: "redo",
        label: "Redo",
        icon: Redo2,
        shortcutId: "redo",
        isAvailable: (editor) => editor.can().redo(),
        run: (editor) => {
          editor.chain().focus().redo().run();
        },
      },
    ],
  },
  {
    id: "block",
    label: "Block type",
    items: [{ kind: "control", id: "blockType", label: "Block type", control: "blockType" }],
  },
  {
    id: "marks",
    label: "Text formatting",
    items: [
      {
        kind: "button",
        id: "bold",
        label: "Bold",
        icon: Bold,
        shortcutId: "bold",
        isActive: (editor) => editor.isActive("bold"),
        run: (editor) => {
          editor.chain().focus().toggleBold().run();
        },
      },
      {
        kind: "button",
        id: "italic",
        label: "Italic",
        icon: Italic,
        shortcutId: "italic",
        isActive: (editor) => editor.isActive("italic"),
        run: (editor) => {
          editor.chain().focus().toggleItalic().run();
        },
      },
      {
        kind: "button",
        id: "underline",
        label: "Underline",
        icon: Underline,
        shortcutId: "underline",
        isActive: (editor) => editor.isActive("underline"),
        run: (editor) => {
          editor.chain().focus().toggleUnderline().run();
        },
      },
      {
        kind: "button",
        id: "strike",
        label: "Strikethrough",
        icon: Strikethrough,
        shortcutId: "strike",
        isActive: (editor) => editor.isActive("strike"),
        run: (editor) => {
          editor.chain().focus().toggleStrike().run();
        },
      },
      {
        kind: "button",
        id: "code",
        label: "Inline code",
        icon: Code,
        shortcutId: "code",
        isActive: (editor) => editor.isActive("code"),
        run: (editor) => {
          editor.chain().focus().toggleCode().run();
        },
      },
      {
        kind: "button",
        id: "subscript",
        label: "Subscript",
        icon: Subscript,
        shortcutId: "subscript",
        isActive: (editor) => editor.isActive("subscript"),
        run: (editor) => {
          editor.chain().focus().toggleSubscript().run();
        },
      },
      {
        kind: "button",
        id: "superscript",
        label: "Superscript",
        icon: Superscript,
        shortcutId: "superscript",
        isActive: (editor) => editor.isActive("superscript"),
        run: (editor) => {
          editor.chain().focus().toggleSuperscript().run();
        },
      },
    ],
  },
  {
    id: "appearance",
    label: "Size and colour",
    items: [
      { kind: "control", id: "fontSize", label: "Font size", control: "fontSize" },
      { kind: "control", id: "textColor", label: "Text colour", control: "textColor" },
      {
        kind: "control",
        id: "highlightColor",
        label: "Highlight colour",
        control: "highlightColor",
      },
    ],
  },
  {
    id: "alignment",
    label: "Alignment",
    items: [
      alignmentCommand("alignLeft", "Align left", AlignLeft, "left", "alignLeft"),
      alignmentCommand("alignCenter", "Align center", AlignCenter, "center", "alignCenter"),
      alignmentCommand("alignRight", "Align right", AlignRight, "right", "alignRight"),
      alignmentCommand("alignJustify", "Justify", AlignJustify, "justify", "alignJustify"),
    ],
  },
  {
    id: "lists",
    label: "Lists",
    items: [
      {
        kind: "button",
        id: "bulletList",
        label: "Bulleted list",
        icon: List,
        shortcutId: "bulletList",
        isActive: (editor) => editor.isActive("bulletList"),
        run: (editor) => {
          editor.chain().focus().toggleBulletList().run();
        },
      },
      {
        kind: "button",
        id: "orderedList",
        label: "Numbered list",
        icon: ListOrdered,
        shortcutId: "orderedList",
        isActive: (editor) => editor.isActive("orderedList"),
        run: (editor) => {
          editor.chain().focus().toggleOrderedList().run();
        },
      },
      {
        kind: "button",
        id: "taskList",
        label: "Task list",
        icon: ListTodo,
        shortcutId: "taskList",
        isActive: (editor) => editor.isActive("taskList"),
        run: (editor) => {
          editor.chain().focus().toggleTaskList().run();
        },
      },
    ],
  },
  {
    id: "insert",
    label: "Insert",
    items: [
      {
        kind: "button",
        id: "insertBlockMenu",
        label: "Insert block",
        icon: SquarePlus,
        shortcutId: "insertBlockMenu",
        // Types the `/` trigger at a valid position so the slash menu is
        // reachable without knowing the trigger character.
        isAvailable: (editor) => editor.isEditable,
        run: (editor) => {
          openSlashMenuAtCaret(editor);
        },
      },
      {
        kind: "button",
        id: "mentionMember",
        label: "Mention someone",
        icon: AtSign,
        shortcutId: "mentionMember",
        isAvailable: (editor) => editor.isEditable,
        run: (editor) => {
          openMentionMenuAtCaret(editor);
        },
      },
      { kind: "control", id: "link", label: "Link", control: "link", shortcutId: "link" },
      {
        kind: "button",
        id: "blockquote",
        label: "Blockquote",
        icon: Quote,
        shortcutId: "blockquote",
        isActive: (editor) => editor.isActive("blockquote"),
        run: (editor) => {
          editor.chain().focus().toggleBlockquote().run();
        },
      },
      {
        kind: "button",
        id: "codeBlock",
        label: "Code block",
        icon: SquareCode,
        shortcutId: "codeBlock",
        isActive: (editor) => editor.isActive("codeBlock"),
        run: (editor) => {
          editor.chain().focus().toggleCodeBlock().run();
        },
      },
      {
        kind: "control",
        id: "codeLanguage",
        label: "Code block language",
        control: "codeLanguage",
      },
      {
        kind: "button",
        id: "horizontalRule",
        label: "Horizontal rule",
        icon: Minus,
        run: (editor) => {
          editor.chain().focus().setHorizontalRule().run();
        },
      },
    ],
  },
  {
    id: "table",
    label: "Table",
    items: [{ kind: "control", id: "table", label: "Table", control: "table" }],
  },
  {
    id: "help",
    label: "Help",
    items: [
      {
        kind: "control",
        id: "shortcuts",
        label: "Keyboard shortcuts",
        control: "shortcuts",
        shortcutId: "shortcutsHelp",
      },
    ],
  },
]);

/** Toolbar control ids in visual order; drives the roving tab index. */
export function toolbarItemIds(groups: readonly ToolbarGroup[]): readonly string[] {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}
