import { TableMap } from "@tiptap/pm/tables";

import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

/**
 * Keyboard-accessible column resizing.
 *
 * TipTap's `resizable: true` column handles are pointer-only: they are driven
 * by `mousedown`/`mousemove` coordinates and expose no focusable control. These
 * commands write the same `colwidth` attribute the drag handles write — for
 * every cell in the column, exactly like prosemirror-tables' own
 * `updateColumnWidth` — so a keyboard user can reach identical results from the
 * table menu.
 */

/** Narrowest column the menu will produce, in CSS pixels. */
export const MIN_TABLE_COLUMN_WIDTH = 60;
/** Widest column the menu will produce; stays inside the contract bound. */
export const MAX_TABLE_COLUMN_WIDTH = 720;
/** One press of "wider"/"narrower". */
export const TABLE_COLUMN_WIDTH_STEP = 40;
/**
 * Assumed starting width when a column has never been resized. The real
 * rendered width is only known from layout, which is unavailable to a command,
 * so the first keyboard adjustment steps away from this value instead.
 */
export const DEFAULT_TABLE_COLUMN_WIDTH = 180;

interface ColumnTarget {
  readonly table: ProseMirrorNode;
  readonly tableStart: number;
  readonly map: TableMap;
  readonly column: number;
}

function findColumnTarget(state: EditorState): ColumnTarget | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 1; depth -= 1) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role !== "cell" && role !== "header_cell") continue;
    const table = $from.node(depth - 2);
    if (table.type.spec.tableRole !== "table") return null;
    const tableStart = $from.start(depth - 2);
    const map = TableMap.get(table);
    const cellStart = $from.before(depth) - tableStart;
    const colspan = Number($from.node(depth).attrs.colspan) || 1;
    return { table, tableStart, map, column: map.colCount(cellStart) + colspan - 1 };
  }
  return null;
}

export function isInTable(editor: Editor): boolean {
  return findColumnTarget(editor.state) !== null;
}

/** Stored width of the selection's column, or `null` when it has none. */
export function currentColumnWidth(editor: Editor): number | null {
  const target = findColumnTarget(editor.state);
  if (target === null) return null;
  const { table, map, column } = target;
  for (let row = 0; row < map.height; row += 1) {
    const cellPos = map.map[row * map.width + column];
    if (cellPos === undefined) continue;
    const cell = table.nodeAt(cellPos);
    if (cell === null) continue;
    const colwidth: unknown = cell.attrs.colwidth;
    if (!Array.isArray(colwidth)) continue;
    const colspan = Number(cell.attrs.colspan) || 1;
    const index = colspan === 1 ? 0 : column - map.colCount(cellPos);
    const width: unknown = colwidth[index];
    if (typeof width === "number" && width > 0) return width;
  }
  return null;
}

/**
 * Write `width` (or clear it with `null`) onto every cell that starts in the
 * selection's column. Returns false when the selection is not in a table.
 */
export function setCurrentColumnWidth(editor: Editor, width: number | null): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const target = findColumnTarget(state);
      if (target === null) return false;
      const { table, tableStart, map, column } = target;

      let changed = false;
      for (let row = 0; row < map.height; row += 1) {
        const index = row * map.width + column;
        const cellPos = map.map[index];
        if (cellPos === undefined) continue;
        // Skip a cell already handled through its rowspan in an earlier row.
        if (row > 0 && cellPos === map.map[index - map.width]) continue;
        const cell = table.nodeAt(cellPos);
        if (cell === null) continue;

        const colspan = Number(cell.attrs.colspan) || 1;
        const existing: unknown = cell.attrs.colwidth;
        const widths: number[] = Array.isArray(existing)
          ? existing.map((value) => (typeof value === "number" && value >= 0 ? value : 0))
          : new Array<number>(colspan).fill(0);
        while (widths.length < colspan) widths.push(0);
        widths[colspan === 1 ? 0 : column - map.colCount(cellPos)] = width ?? 0;
        const next = widths.some((value) => value > 0) ? widths : null;

        if (dispatch)
          tr.setNodeMarkup(tableStart + cellPos, undefined, { ...cell.attrs, colwidth: next });
        changed = true;
      }
      return changed;
    })
    .run();
}

/** Step the selection's column width by `delta`, clamped to the allowed range. */
export function adjustCurrentColumnWidth(editor: Editor, delta: number): boolean {
  if (!isInTable(editor)) return false;
  const current = currentColumnWidth(editor) ?? DEFAULT_TABLE_COLUMN_WIDTH;
  const next = Math.min(
    MAX_TABLE_COLUMN_WIDTH,
    Math.max(MIN_TABLE_COLUMN_WIDTH, Math.round(current + delta)),
  );
  return setCurrentColumnWidth(editor, next);
}
