import { Extension } from "@tiptap/core";

// Side-effect import: declares the table command signatures used below.
import "@tiptap/extension-table";

import { editorShortcutBinding } from "../keyboard-shortcuts";

import { canAddTableRow } from "./table-limits";

import type { Editor } from "@tiptap/core";

export type BlockTabDirection = "forward" | "backward";

/** Block contexts that give Tab and Shift+Tab a meaning inside the editor. */
type BlockTabContext = "table" | "taskItem" | "listItem";

function contextForNodeName(name: string): BlockTabContext | null {
  if (name === "tableCell" || name === "tableHeader") return "table";
  if (name === "taskItem") return "taskItem";
  if (name === "listItem") return "listItem";
  return null;
}

function runTableTab(editor: Editor, direction: BlockTabDirection): boolean {
  if (direction === "backward") return editor.commands.goToPreviousCell();
  if (editor.commands.goToNextCell()) return true;
  // Tab in the last cell grows the table, matching every other editor's tables —
  // but only while the shared contract still admits the larger table. At the row
  // or cell bound the key is released to the browser instead, so holding Tab can
  // never build a document `safeParseNoteDocument` rejects (which would silently
  // stop the note reporting, and later persisting, any further change).
  if (!canAddTableRow(editor)) return false;
  if (!editor.can().addRowAfter()) return false;
  return editor.chain().addRowAfter().goToNextCell().run();
}

function runListTab(editor: Editor, itemName: string, direction: BlockTabDirection): boolean {
  return direction === "forward"
    ? editor.commands.sinkListItem(itemName)
    : editor.commands.liftListItem(itemName);
}

/**
 * Single Tab/Shift+Tab handler for the note editor.
 *
 * Precedence is innermost-context-first, then outward:
 *
 * 1. Walk the selection's ancestors from the innermost node outwards.
 * 2. The first table cell, task item, or list item found gets the first
 *    attempt: cells move to the next/previous cell (Tab in the last cell adds
 *    a row); items indent/outdent.
 * 3. If that attempt changes nothing — a first list item that cannot indent,
 *    for example — the next enclosing context is tried. A checklist inside a
 *    table cell therefore indents while it can and moves between cells once it
 *    cannot.
 * 4. When no context applies, the handler returns `false` so the browser moves
 *    focus out of the editor. A contenteditable that swallows Tab is a
 *    WCAG 2.1.2 keyboard trap, so Tab is never consumed "just in case".
 *
 * The extension runs before TipTap's own Table, TaskItem, and ListItem Tab
 * bindings (higher priority), so exactly one rule decides the outcome.
 */
export function runBlockTab(editor: Editor, direction: BlockTabDirection): boolean {
  const { $from } = editor.state.selection;
  const attempted = new Set<BlockTabContext>();

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const context = contextForNodeName($from.node(depth).type.name);
    if (context === null || attempted.has(context)) continue;
    attempted.add(context);
    const handled =
      context === "table" ? runTableTab(editor, direction) : runListTab(editor, context, direction);
    if (handled) return true;
  }
  return false;
}

export const NoteBlockTab = Extension.create({
  name: "nottedBlockTab",

  // Above TipTap's default 100 so Table, TaskItem, and ListItem cannot claim
  // Tab before the deliberate precedence above has been applied.
  priority: 200,

  addKeyboardShortcuts() {
    return {
      [editorShortcutBinding("indentBlock")]: () => runBlockTab(this.editor, "forward"),
      [editorShortcutBinding("outdentBlock")]: () => runBlockTab(this.editor, "backward"),
    };
  },
});
