import { NOTE_DOCUMENT_LIMITS } from "@notted/shared-validators";
import { TableMap } from "@tiptap/pm/tables";

import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

/**
 * Growth guards for tables.
 *
 * ProseMirror's table commands know nothing about the shared document contract,
 * so `addRowAfter`, `addColumnAfter`, and `insertTable` will happily build a
 * table the contract rejects. A rejected document stops being reported through
 * `onDocumentChange`, which later means it stops being saved, so growth is
 * refused *before* it happens rather than diagnosed afterwards.
 *
 * Rows and columns are bounded per table because the contract bounds them per
 * node (`table` children, `tableRow` children). Cells are bounded across the
 * whole document because the contract counts them that way — one shared counter
 * for every table in the note, nested tables included.
 */

const TABLE_CELL_NODE_NAMES: ReadonlySet<string> = new Set(["tableCell", "tableHeader"]);

/** Every table cell in the document, counted exactly as the contract counts them. */
export function documentTableCellCount(doc: ProseMirrorNode): number {
  let cells = 0;
  // Descends into cells as well: the contract allows a table inside a cell, and
  // its cells share the same document-wide budget.
  doc.descendants((node) => {
    if (TABLE_CELL_NODE_NAMES.has(node.type.name)) cells += 1;
    return true;
  });
  return cells;
}

export interface EnclosingTable {
  readonly node: ProseMirrorNode;
  /** `tableRow` children, which is what the contract's row bound counts. */
  readonly rows: number;
  /**
   * Grid width. With colspans this is at least the widest row's child count, so
   * using it for the column bound refuses growth no later than the contract
   * would, never later.
   */
  readonly columns: number;
}

/** The innermost table containing the selection, or `null` outside a table. */
export function enclosingTable(state: EditorState): EnclosingTable | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.spec.tableRole !== "table") continue;
    return { node, rows: node.childCount, columns: TableMap.get(node).width };
  }
  return null;
}

/** Whether `count` more cells still fit inside the document-wide cell budget. */
export function canAddTableCells(editor: Editor, count: number): boolean {
  return documentTableCellCount(editor.state.doc) + count <= NOTE_DOCUMENT_LIMITS.maxTableCells;
}

/**
 * Whether one more row may be added to the table around the selection. False
 * outside a table, at the row bound, or when the new row's cells would exceed
 * the document's cell budget.
 */
export function canAddTableRow(editor: Editor): boolean {
  const table = enclosingTable(editor.state);
  if (table === null) return false;
  if (table.rows >= NOTE_DOCUMENT_LIMITS.maxTableRows) return false;
  return canAddTableCells(editor, table.columns);
}

/** The column counterpart of `canAddTableRow`. */
export function canAddTableColumn(editor: Editor): boolean {
  const table = enclosingTable(editor.state);
  if (table === null) return false;
  if (table.columns >= NOTE_DOCUMENT_LIMITS.maxTableColumns) return false;
  return canAddTableCells(editor, table.rows);
}

/** Whether a fresh `rows` x `columns` table still fits the cell budget. */
export function canInsertTableOfSize(editor: Editor, rows: number, columns: number): boolean {
  return canAddTableCells(editor, rows * columns);
}

const TABLE_CELL_ROLES: ReadonlySet<string> = new Set(["cell", "header_cell"]);

/**
 * How many cells splitting the cell around the selection would add.
 *
 * Splitting replaces one merged cell with `colspan * rowspan` single cells, so
 * the document grows by that product minus the cell being replaced. A cell that
 * spans nothing splits into itself and costs nothing. Returns `0` outside a
 * cell, which makes the guard a no-op there and leaves the decision to
 * ProseMirror's own `splitCell`.
 */
export function splitCellGrowth(state: EditorState): number {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!TABLE_CELL_ROLES.has(node.type.spec.tableRole ?? "")) continue;
    const colspan = typeof node.attrs.colspan === "number" ? node.attrs.colspan : 1;
    const rowspan = typeof node.attrs.rowspan === "number" ? node.attrs.rowspan : 1;
    return Math.max(0, colspan * rowspan - 1);
  }
  return 0;
}

/**
 * Whether the merged cell around the selection may be split.
 *
 * Splitting is the one table operation that grows the document without adding a
 * row or a column, so it needs the same cell-budget guard the growth actions
 * carry — otherwise a table pasted at the bound containing a spanned cell could
 * still be pushed past it.
 */
export function canSplitTableCell(editor: Editor): boolean {
  return canAddTableCells(editor, splitCellGrowth(editor.state));
}
