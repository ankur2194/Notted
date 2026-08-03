import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

/**
 * Where the `/` and `@` triggers are legal, and how to type them on the user's
 * behalf.
 *
 * These rules live apart from both the command table and the TipTap extensions
 * so the toolbar can offer "Insert block" and "Mention someone" without
 * importing the extensions (which import the command table, which imports the
 * toolbar). They are pure functions over editor state, so every accept and
 * reject case is directly testable.
 */

export const SLASH_COMMAND_TRIGGER = "/";
export const MENTION_TRIGGER = "@";

function isOrdinaryTextblock(state: EditorState, from: number): boolean {
  if (from < 0 || from > state.doc.content.size) return false;
  const parent = state.doc.resolve(from).parent;
  // A code block's `/` and `@` are source text, never commands.
  return parent.isTextblock && parent.type.spec.code !== true;
}

/**
 * A valid slash position is the very start of an ordinary text block.
 *
 * All of the following must hold at the position of the typed `/`:
 *
 * - the enclosing node is a text block — a paragraph, a heading, a list item's
 *   paragraph, or a paragraph inside a blockquote or table cell;
 * - it is not a code block;
 * - the `/` is that block's first character, so `and/or`, `Notes/2026`, and a
 *   pasted `https://example.test/path` can never open the menu.
 *
 * Table cells are deliberately allowed: a cell holds ordinary paragraphs, and
 * headings, lists, and code blocks are all legitimate inside one.
 */
export function isSlashCommandPosition(state: EditorState, from: number): boolean {
  if (!isOrdinaryTextblock(state, from)) return false;
  return state.doc.resolve(from).parentOffset === 0;
}

/**
 * A mention may start anywhere inline that the schema accepts a mention node,
 * except inside a code block. Unlike the slash menu it is not restricted to the
 * start of a line — mid-sentence is exactly where mentions belong — but the
 * suggestion matcher still requires the `@` to follow whitespace or begin the
 * text, so `name@example.test` never opens it.
 */
export function isMentionPosition(state: EditorState, from: number, nodeName: string): boolean {
  if (!isOrdinaryTextblock(state, from)) return false;
  const type = state.schema.nodes[nodeName];
  if (type === undefined) return false;
  return state.doc.resolve(from).parent.type.contentMatch.matchType(type) !== null;
}

/**
 * Open the slash menu by typing the trigger for the user. When the caret is
 * mid-block a new block is started first, so the trigger always lands at a
 * valid position instead of silently doing nothing.
 */
export function openSlashMenuAtCaret(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code === true) return false;
  if ($from.parentOffset === 0) {
    return editor.chain().focus().insertContent(SLASH_COMMAND_TRIGGER).run();
  }
  return editor.chain().focus().splitBlock().insertContent(SLASH_COMMAND_TRIGGER).run();
}

/**
 * Insert the mention trigger, adding the leading space the suggestion matcher
 * requires when the caret sits directly after a word.
 */
export function openMentionMenuAtCaret(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code === true) return false;
  const previous =
    $from.parentOffset === 0
      ? ""
      : $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset);
  const prefix = previous === "" || /\s/u.test(previous) ? "" : " ";
  return editor.chain().focus().insertContent(`${prefix}${MENTION_TRIGGER}`).run();
}
