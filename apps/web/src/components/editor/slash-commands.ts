import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  SquareCode,
  Table2,
} from "lucide-react";

// Side-effect imports: each declares the TipTap command signatures used below.
import "@tiptap/extension-table";
import "@tiptap/extension-task-list";

import { TABLE_ACTIONS } from "./toolbar-commands";

import type { ChainedCommands, Editor, Range } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";

/**
 * Slash menu contents expressed as data.
 *
 * Part 38 (`/page-break`) and Part 42 (`/image`) each append exactly one entry
 * to `SLASH_COMMANDS`; neither node exists in the shared document contract yet,
 * so offering them now would ship a menu item that cannot produce a valid
 * document. Nothing in `SlashCommandMenu.tsx`, the suggestion extension, or the
 * filtering below needs to change when they are added.
 */
export interface SlashCommand {
  readonly id: string;
  /** Accessible name and primary match target. */
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** Extra match terms, including the `Notted.md` spellings such as `bullet-list`. */
  readonly keywords: readonly string[];
  /** Absent means always offered. Present when the command can genuinely not run. */
  readonly isAvailable?: (editor: Editor) => boolean;
  /**
   * Applies the command. Implementations must delete exactly `range` — the
   * `/query` text the user typed — and nothing else.
   */
  readonly run: (editor: Editor, range: Range) => void;
}

const INSERT_TABLE_ACTION = TABLE_ACTIONS.find((action) => action.id === "insertTable");
if (INSERT_TABLE_ACTION === undefined) {
  // A wiring bug rather than a runtime condition: the slash menu deliberately
  // reuses the toolbar's single table-insertion definition.
  throw new Error("TABLE_ACTIONS is missing the insertTable action");
}
const insertTableAction = INSERT_TABLE_ACTION;

/**
 * Delete exactly the typed `/query` range, then apply `chain`.
 *
 * `deleteRange` is scoped to the suggestion match, so text before the trigger
 * and text after the caret are untouched no matter how long the query is.
 */
function replaceRange(apply: (chain: ChainedCommands) => ChainedCommands) {
  return (editor: Editor, range: Range): void => {
    apply(editor.chain().focus().deleteRange(range)).run();
  };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  {
    id: "heading1",
    label: "Heading 1",
    description: "Top-level section title",
    icon: Heading1,
    keywords: ["heading-1", "h1", "title"],
    run: replaceRange((chain) => chain.setNode("heading", { level: 1 })),
  },
  {
    id: "heading2",
    label: "Heading 2",
    description: "Section title",
    icon: Heading2,
    keywords: ["heading-2", "h2", "subtitle"],
    run: replaceRange((chain) => chain.setNode("heading", { level: 2 })),
  },
  {
    id: "heading3",
    label: "Heading 3",
    description: "Subsection title",
    icon: Heading3,
    keywords: ["heading-3", "h3"],
    run: replaceRange((chain) => chain.setNode("heading", { level: 3 })),
  },
  {
    id: "paragraph",
    label: "Paragraph",
    description: "Plain body text",
    icon: Pilcrow,
    keywords: ["text", "body", "normal"],
    run: replaceRange((chain) => chain.setParagraph()),
  },
  {
    id: "bulletList",
    label: "Bulleted list",
    description: "Unordered list",
    icon: List,
    keywords: ["bullet-list", "bullet", "unordered", "ul"],
    run: replaceRange((chain) => chain.toggleBulletList()),
  },
  {
    id: "orderedList",
    label: "Numbered list",
    description: "Ordered list",
    icon: ListOrdered,
    keywords: ["ordered-list", "numbered", "ol"],
    run: replaceRange((chain) => chain.toggleOrderedList()),
  },
  {
    id: "taskList",
    label: "Task list",
    description: "Checklist with checkboxes",
    icon: ListTodo,
    keywords: ["task-list", "todo", "checklist", "checkbox"],
    run: replaceRange((chain) => chain.toggleTaskList()),
  },
  {
    id: "table",
    label: insertTableAction.label,
    description: "Table with a header row",
    icon: Table2,
    keywords: ["table", "grid", "rows", "columns"],
    isAvailable: (editor) => insertTableAction.isAvailable(editor),
    run: (editor, range) => {
      // The trigger text is removed first so the reused toolbar action inserts
      // the table into an otherwise untouched block.
      editor.chain().focus().deleteRange(range).run();
      insertTableAction.run(editor);
    },
  },
  {
    id: "blockquote",
    label: "Blockquote",
    description: "Quoted passage",
    icon: Quote,
    keywords: ["quote", "citation"],
    run: replaceRange((chain) => chain.toggleBlockquote()),
  },
  {
    id: "codeBlock",
    label: "Code block",
    description: "Preformatted, syntax-highlighted code",
    icon: SquareCode,
    keywords: ["code-block", "code", "pre", "snippet"],
    run: replaceRange((chain) => chain.toggleCodeBlock()),
  },
  {
    id: "divider",
    label: "Divider",
    description: "Horizontal rule between sections",
    icon: Minus,
    keywords: ["divider", "horizontal-rule", "hr", "separator", "line"],
    run: replaceRange((chain) => chain.setHorizontalRule()),
  },
]);

/**
 * Fold a label, keyword, or query to its comparable form so `bullet list`,
 * `bullet-list`, and `bulletlist` all match one another.
 */
export function normalizeSlashQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/** Commands that can actually run against the current selection. */
export function availableSlashCommands(
  editor: Editor,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): readonly SlashCommand[] {
  return commands.filter((command) => command.isAvailable?.(editor) ?? true);
}

/** Substring match over the label and every declared keyword. */
export function filterSlashCommands(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): readonly SlashCommand[] {
  const needle = normalizeSlashQuery(query);
  if (needle.length === 0) return commands;
  return commands.filter((command) =>
    [command.label, ...command.keywords].some((term) => normalizeSlashQuery(term).includes(needle)),
  );
}
