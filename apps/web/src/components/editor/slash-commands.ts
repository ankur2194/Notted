import {
  CalendarClock,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Paperclip,
  Pilcrow,
  Quote,
  ScissorsLineDashed,
  SquareCode,
  Table2,
} from "lucide-react";

// Side-effect imports: each declares the TipTap command signatures used below.
import "@tiptap/extension-table";
import "@tiptap/extension-task-list";
// Declares `setPageBreak` on the chained-command interface (Part 38).
import "./extensions/page-break";
// Declares `nottedRequestImageUpload` on the same interface (Part 42).
import "./extensions/CustomImage";
// Declares `nottedRequestAttachmentUpload` on the same interface (Part 44).
import "./extensions/CustomAttachment";

import { TABLE_ACTIONS } from "./toolbar-commands";

import {
  isMeetingExtractionAvailable,
  openMeetingExtraction,
} from "@/lib/ai/meeting-extraction-request";

import type { ChainedCommands, Editor, Range } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";

/**
 * Slash menu contents expressed as data.
 *
 * Part 38 appended `/page-break` after adding `pageBreak` to the shared document
 * contract; Part 42 appends `/image` the same way. A menu entry is only ever
 * added once the contract can represent the node it produces, or the command
 * would ship a document the API refuses to store. Nothing in
 * `SlashCommandMenu.tsx`, the suggestion extension, or the filtering below needs
 * to change when one is added.
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
  {
    id: "pageBreak",
    label: "Page break",
    description: "Start the following content on a new printed page",
    icon: ScissorsLineDashed,
    keywords: ["page-break", "pagebreak", "new-page", "pagination", "print"],
    run: replaceRange((chain) => chain.setPageBreak()),
  },
  {
    id: "image",
    label: "Image",
    description: "Upload an image from this device",
    icon: ImagePlus,
    keywords: ["image", "picture", "photo", "upload", "attachment", "media"],
    /*
     * Inserts nothing on its own, and that is deliberate. The command deletes
     * the typed `/image` and asks the host to open the file picker; the image
     * node only ever appears once real bytes have a permanent attachment id.
     * Nothing temporary is written to the document at any point.
     */
    run: replaceRange((chain) => chain.nottedRequestImageUpload()),
  },
  {
    id: "attachment",
    label: "File attachment",
    description: "Attach a document, spreadsheet, archive, or text file",
    icon: Paperclip,
    keywords: [
      "attachment",
      "file",
      "attach",
      "upload",
      "document",
      "pdf",
      "docx",
      "xlsx",
      "zip",
      "archive",
    ],
    /*
     * Like `/image`, it inserts nothing on its own: the typed `/attachment` is
     * deleted and the host is asked to open the file picker. The card only ever
     * appears once real bytes have a permanent attachment id, so no temporary
     * reference is ever written to the document.
     */
    run: replaceRange((chain) => chain.nottedRequestAttachmentUpload()),
  },
  {
    id: "meetingExtraction",
    label: "Extract meeting notes",
    description: "Turn a pasted transcript into attendees, decisions, and action items",
    icon: CalendarClock,
    keywords: ["meeting", "transcript", "minutes", "action-items", "notes", "ai"],
    /*
     * Offered only while the dialog is mounted and able to serve the command —
     * AI enabled and configured, the note editable, an editor mounted. The
     * registration IS the availability check, so this entry never has to
     * duplicate the dialog's conditions or read the workspace's AI status.
     */
    isAvailable: () => isMeetingExtractionAvailable(),
    /*
     * Inserts nothing on its own, exactly like `/image` and `/attachment`: it
     * deletes the typed `/…` and asks the host to open the review dialog. Note
     * content only ever appears once a human has confirmed what a model found,
     * so nothing provisional is written to the document at any point.
     *
     * Shaped like the `table` entry rather than `replaceRange`: the typed range
     * is deleted by its own chain first, so opening the dialog is a plain side
     * effect and can never be entangled with whether a chained command reported
     * success.
     */
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      openMeetingExtraction();
    },
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
