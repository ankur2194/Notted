import {
  NOTE_DOCUMENT_LIMITS,
  safeParseNoteDocument,
  type NoteDocument,
} from "@notted/shared-validators";
import { screen, waitFor, within } from "@testing-library/react";
import { CellSelection } from "@tiptap/pm/tables";
import { describe, expect, it } from "vitest";

import { runBlockTab } from "./extensions/note-block-tab";
import {
  DEFAULT_TABLE_COLUMN_WIDTH,
  MAX_TABLE_COLUMN_WIDTH,
  MIN_TABLE_COLUMN_WIDTH,
  TABLE_COLUMN_WIDTH_STEP,
  adjustCurrentColumnWidth,
  currentColumnWidth,
  isInTable,
  setCurrentColumnWidth,
} from "./extensions/table-column-width";

import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";

import { renderEditor, type EditorHarness } from "@/test/editor-harness";

const EMPTY_DOCUMENT: NoteDocument = { type: "doc", content: [{ type: "paragraph" }] };

function cellAttrs(overrides: Record<string, unknown> = {}) {
  return { colspan: 1, rowspan: 1, colwidth: null, ...overrides };
}

function cell(text: string, header = false) {
  return {
    type: header ? "tableHeader" : "tableCell",
    attrs: cellAttrs(),
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** 2x2 table: one header row and one body row. */
const TABLE_DOCUMENT: NoteDocument = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell("H1", true), cell("H2", true)] },
        { type: "tableRow", content: [cell("a1"), cell("a2")] },
      ],
    },
  ],
};

function emptyCell(header = false) {
  return {
    type: header ? "tableHeader" : "tableCell",
    attrs: cellAttrs(),
    content: [{ type: "paragraph" }],
  };
}

/** A `rows` x `columns` table of empty cells, built directly rather than by pressing keys. */
function tableOfSize(rows: number, columns: number) {
  return {
    type: "table",
    content: Array.from({ length: rows }, (_unused, row) => ({
      type: "tableRow",
      content: Array.from({ length: columns }, () => emptyCell(row === 0)),
    })),
  };
}

function tableDocument(rows: number, columns: number, trailing = false): NoteDocument {
  const content = [tableOfSize(rows, columns)];
  return {
    type: "doc",
    content: trailing ? [...content, { type: "paragraph" }] : content,
  };
}

function tableNode(editor: Editor): ProseMirrorNode {
  const node = editor.state.doc.firstChild;
  if (node === null || node.type.name !== "table") throw new Error("document has no table");
  return node;
}

function rowCount(editor: Editor): number {
  return tableNode(editor).childCount;
}

function columnCount(editor: Editor): number {
  const first = tableNode(editor).firstChild;
  return first === null ? 0 : first.childCount;
}

function cellTexts(editor: Editor): string[][] {
  const rows: string[][] = [];
  tableNode(editor).forEach((row) => {
    const cells: string[] = [];
    row.forEach((current) => cells.push(current.textContent));
    rows.push(cells);
  });
  return rows;
}

function hasTable(editor: Editor): boolean {
  return editor.state.doc.firstChild?.type.name === "table";
}

/** Document position immediately before each cell, grouped by row. */
function cellPositions(editor: Editor): readonly (readonly number[])[] {
  const rows: number[][] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableRow") {
      rows.push([]);
      return true;
    }
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      rows[rows.length - 1]?.push(pos);
      return false;
    }
    return true;
  });
  return rows;
}

function cellPosition(editor: Editor, row: number, column: number): number {
  const position = cellPositions(editor)[row]?.[column];
  if (position === undefined) throw new Error(`no cell at row ${row}, column ${column}`);
  return position;
}

/** Put the caret inside the cell at `row`/`column` (0-based). */
function caretInCell(editor: Editor, row: number, column: number): void {
  editor.commands.setTextSelection(cellPosition(editor, row, column) + 2);
}

async function openTableDialog(harness: EditorHarness): Promise<HTMLElement> {
  await harness.user.click(screen.getByRole("button", { name: /^Table/u }));
  return screen.findByRole("dialog", { name: "Table" });
}

async function runTableAction(harness: EditorHarness, label: string | RegExp): Promise<void> {
  const dialog = await openTableDialog(harness);
  await harness.user.click(within(dialog).getByRole("button", { name: label }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Table" })).toBeNull());
}

function expectContractValid(editor: Editor): void {
  const result = safeParseNoteDocument(editor.getJSON());
  expect(result.success ? [] : result.errors).toEqual([]);
}

describe("table insertion and structure commands", () => {
  it("inserts a 3 by 3 table with a header row that satisfies the shared contract", async () => {
    const harness = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await runTableAction(harness, "Insert 3 by 3 table");

    expect(rowCount(harness.editor)).toBe(3);
    expect(columnCount(harness.editor)).toBe(3);
    expect(tableNode(harness.editor).firstChild?.firstChild?.type.name).toBe("tableHeader");
    expectContractValid(harness.editor);
  });

  it.each([
    ["Add row above", 3, 2],
    ["Add row below", 3, 2],
    ["Add column before", 2, 3],
    ["Add column after", 2, 3],
    ["Delete row", 1, 2],
    ["Delete column", 2, 1],
  ])("applies %s and keeps the document contract-valid", async (label, rows, columns) => {
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(harness.editor, 1, 0);
    await runTableAction(harness, label);

    expect(rowCount(harness.editor)).toBe(rows);
    expect(columnCount(harness.editor)).toBe(columns);
    expectContractValid(harness.editor);
    harness.unmount();
  });

  it("merges a cell selection and splits it again", async () => {
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    // Select both cells of the body row so `mergeCells` has something to merge.
    harness.editor.commands.setCellSelection({
      anchorCell: cellPosition(harness.editor, 1, 0),
      headCell: cellPosition(harness.editor, 1, 1),
    });
    expect(cellTexts(harness.editor)[1]).toEqual(["a1", "a2"]);

    await runTableAction(harness, "Merge selected cells");
    expect(cellTexts(harness.editor)[1]).toHaveLength(1);
    expect(tableNode(harness.editor).child(1).firstChild?.attrs.colspan).toBe(2);
    expectContractValid(harness.editor);

    await runTableAction(harness, "Split cell");
    expect(cellTexts(harness.editor)[1]).toHaveLength(2);
    expectContractValid(harness.editor);
  });

  it("toggles the header row off and on", async () => {
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(harness.editor, 0, 0);
    await runTableAction(harness, "Toggle header row");
    expect(tableNode(harness.editor).firstChild?.firstChild?.type.name).toBe("tableCell");
    expectContractValid(harness.editor);

    caretInCell(harness.editor, 0, 0);
    await runTableAction(harness, "Toggle header row");
    expect(tableNode(harness.editor).firstChild?.firstChild?.type.name).toBe("tableHeader");
    expectContractValid(harness.editor);
  });

  it("deletes the whole table", async () => {
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(harness.editor, 1, 1);
    await runTableAction(harness, "Delete table");

    expect(hasTable(harness.editor)).toBe(false);
    expectContractValid(harness.editor);
  });

  it("disables every table operation while the selection is outside a table", async () => {
    const harness = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await harness.user.click(screen.getByRole("button", { name: /^Table/u }));
    const dialog = await screen.findByRole("dialog", { name: "Table" });

    expect(within(dialog).getByRole("button", { name: "Insert 3 by 3 table" })).toBeEnabled();
    for (const label of ["Add row above", "Delete column", "Widen column", "Delete table"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeDisabled();
    }
  });

  it("marks row growth unavailable at the contract's row limit", async () => {
    const rows = NOTE_DOCUMENT_LIMITS.maxTableRows;
    const harness = await renderEditor({ initialDocument: tableDocument(rows, 2) });
    caretInCell(harness.editor, rows - 1, 0);
    const dialog = await openTableDialog(harness);

    for (const label of ["Add row above", "Add row below"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeDisabled();
    }
    // Columns are unaffected: 200 cells leaves room inside the cell budget.
    expect(within(dialog).getByRole("button", { name: "Add column after" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Delete row" })).toBeEnabled();
    expect(rowCount(harness.editor)).toBe(rows);
    expectContractValid(harness.editor);
  });

  it("marks every growth action unavailable at the contract's cell limit", async () => {
    const columns = 10;
    const rows = NOTE_DOCUMENT_LIMITS.maxTableCells / columns;
    const harness = await renderEditor({ initialDocument: tableDocument(rows, columns) });
    caretInCell(harness.editor, 0, 0);
    const dialog = await openTableDialog(harness);

    for (const label of [
      "Add row above",
      "Add row below",
      "Add column before",
      "Add column after",
    ]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeDisabled();
    }
    expect(within(dialog).getByRole("button", { name: "Delete row" })).toBeEnabled();
    expectContractValid(harness.editor);
  });

  it("refuses to split a spanned cell once the cell budget is spent", async () => {
    // Splitting is the one operation that grows the document without adding a
    // row or a column, so it needs the same budget guard as the growth actions.
    // The budget is document-wide, so a filler table spends it down to three
    // cells short — one fewer than splitting a 4-wide cell would need.
    const filler = tableOfSize(46, 13); // 598 cells
    const spanned: NoteDocument = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: cellAttrs({ colspan: 4 }),
                  content: [{ type: "paragraph" }],
                },
              ],
            },
          ],
        },
        filler,
      ],
    };
    const harness = await renderEditor({ initialDocument: spanned });
    caretInCell(harness.editor, 0, 0);
    const dialog = await openTableDialog(harness);

    expect(within(dialog).getByRole("button", { name: "Split cell" })).toBeDisabled();
    expectContractValid(harness.editor);
  });

  it("splits a spanned cell when the budget still allows it", async () => {
    const spanned: NoteDocument = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: cellAttrs({ colspan: 2 }),
                  content: [{ type: "paragraph" }],
                },
              ],
            },
            { type: "tableRow", content: [emptyCell(), emptyCell()] },
          ],
        },
      ],
    };
    const harness = await renderEditor({ initialDocument: spanned });
    caretInCell(harness.editor, 0, 0);
    await runTableAction(harness, "Split cell");

    expect(columnCount(harness.editor)).toBe(2);
    expectContractValid(harness.editor);
  });

  it("keeps the table extension's delete-table keyboard binding after the Tab strip", async () => {
    // `createNoteEditorExtensions` removes only Tab/Shift-Tab from the Table
    // keymap so `NoteBlockTab` is the single Tab authority. The extension's own
    // "delete the table when every cell is selected" binding must survive.
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    const { editor } = harness;
    const first = cellPosition(editor, 0, 0);
    const last = cellPosition(editor, 1, 1);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, first, last) as unknown as Selection,
      ),
    );
    harness.focusEditor();
    harness.pressKey("Backspace");

    await waitFor(() => expect(hasTable(editor)).toBe(false));
    expectContractValid(editor);
  });

  it("refuses a whole new table once the cell budget is spent", async () => {
    const columns = 10;
    const rows = NOTE_DOCUMENT_LIMITS.maxTableCells / columns;
    const harness = await renderEditor({
      // A paragraph after the table, so the caret sits where a new table would
      // legitimately go and only the cell budget can refuse it.
      initialDocument: tableDocument(rows, columns, true),
    });
    harness.editor.commands.setTextSelection(harness.editor.state.doc.content.size - 1);
    const dialog = await openTableDialog(harness);

    // A 3x3 table needs another nine cells the document cannot spend.
    expect(within(dialog).getByRole("button", { name: "Insert 3 by 3 table" })).toBeDisabled();
    expectContractValid(harness.editor);
  });

  it("undoes and redoes a table operation", async () => {
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(harness.editor, 1, 0);
    await runTableAction(harness, "Add row below");
    expect(rowCount(harness.editor)).toBe(3);

    await harness.user.click(screen.getByRole("button", { name: /^Undo/u }));
    expect(rowCount(harness.editor)).toBe(2);

    await harness.user.click(screen.getByRole("button", { name: /^Redo/u }));
    expect(rowCount(harness.editor)).toBe(3);
    expectContractValid(harness.editor);
  });
});

describe("table column width", () => {
  /*
   * TipTap's drag handles resolve document positions from pointer coordinates
   * (`posAtCoords`), which jsdom cannot produce. The attribute path the handles
   * write is exercised directly here instead, through the same commands the
   * keyboard-accessible menu actions use. Pointer dragging itself is verified in
   * a real browser.
   */
  it("writes colwidth on every cell of the column and validates", async () => {
    const { editor } = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(editor, 0, 1);
    expect(isInTable(editor)).toBe(true);
    expect(currentColumnWidth(editor)).toBeNull();

    expect(setCurrentColumnWidth(editor, 240)).toBe(true);
    expect(currentColumnWidth(editor)).toBe(240);

    const widths = cellTexts(editor).map(
      (_row, index) => tableNode(editor).child(index).child(1).attrs.colwidth,
    );
    expect(widths).toEqual([[240], [240]]);
    expect(tableNode(editor).child(0).child(0).attrs.colwidth).toBeNull();
    expectContractValid(editor);
  });

  it("steps and clears the width through the accessible menu actions", async () => {
    const harness = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(harness.editor, 1, 0);

    await runTableAction(harness, "Widen column");
    expect(currentColumnWidth(harness.editor)).toBe(
      DEFAULT_TABLE_COLUMN_WIDTH + TABLE_COLUMN_WIDTH_STEP,
    );

    caretInCell(harness.editor, 1, 0);
    await runTableAction(harness, "Narrow column");
    expect(currentColumnWidth(harness.editor)).toBe(DEFAULT_TABLE_COLUMN_WIDTH);

    caretInCell(harness.editor, 1, 0);
    await runTableAction(harness, "Reset column width");
    expect(currentColumnWidth(harness.editor)).toBeNull();
    expectContractValid(harness.editor);
  });

  it("clamps stepped widths to the allowed range", async () => {
    const { editor } = await renderEditor({ initialDocument: TABLE_DOCUMENT });
    caretInCell(editor, 1, 0);
    expect(adjustCurrentColumnWidth(editor, -10_000)).toBe(true);
    expect(currentColumnWidth(editor)).toBe(MIN_TABLE_COLUMN_WIDTH);

    caretInCell(editor, 1, 0);
    expect(adjustCurrentColumnWidth(editor, 10_000)).toBe(true);
    expect(currentColumnWidth(editor)).toBe(MAX_TABLE_COLUMN_WIDTH);
    expectContractValid(editor);
  });

  it("reports no table context outside a table", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    expect(isInTable(editor)).toBe(false);
    expect(currentColumnWidth(editor)).toBeNull();
    expect(setCurrentColumnWidth(editor, 200)).toBe(false);
  });
});

describe("table Tab navigation", () => {
  it("moves to the next and previous cell", async () => {
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: TABLE_DOCUMENT,
    });
    focusEditor();
    caretInCell(editor, 0, 0);

    pressKey("Tab");
    expect(editor.state.selection.$from.parent.textContent).toBe("H2");

    pressKey("Tab", { shiftKey: true });
    expect(editor.state.selection.$from.parent.textContent).toBe("H1");
  });

  it("adds a row when Tab is pressed in the last cell", async () => {
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: TABLE_DOCUMENT,
    });
    focusEditor();
    caretInCell(editor, 1, 1);

    pressKey("Tab");
    expect(rowCount(editor)).toBe(3);
    expect(editor.state.selection.$from.parent.textContent).toBe("");
    expectContractValid(editor);
  });

  /*
   * Growth is bounded by the shared contract, not by ProseMirror. `addRowAfter`
   * knows nothing about `NOTE_DOCUMENT_LIMITS`, so holding Tab in the last cell
   * would otherwise build a document `safeParseNoteDocument` rejects — at which
   * point `TiptapEditor` stops reporting (and, from Part 39, stops persisting)
   * every later change. The tables below are constructed at the limit rather
   * than grown by pressing Tab a hundred times.
   */
  it("refuses to grow a table past the contract's row limit", async () => {
    const rows = NOTE_DOCUMENT_LIMITS.maxTableRows;
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: tableDocument(rows, 2),
    });
    expectContractValid(editor);
    focusEditor();
    caretInCell(editor, rows - 1, 1);

    pressKey("Tab");
    expect(rowCount(editor)).toBe(rows);
    expectContractValid(editor);
    // False means the keymap did not consume Tab, so the browser still moves
    // focus out of the editor: refusing growth must not create a keyboard trap.
    expect(runBlockTab(editor, "forward")).toBe(false);
  });

  it("refuses to grow a table past the contract's document-wide cell limit", async () => {
    // 60 x 10 = exactly `maxTableCells`, while the row count stays well under
    // `maxTableRows`, so only the cell budget can refuse the next row.
    const columns = 10;
    const rows = NOTE_DOCUMENT_LIMITS.maxTableCells / columns;
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: tableDocument(rows, columns),
    });
    expect(rows).toBeLessThan(NOTE_DOCUMENT_LIMITS.maxTableRows);
    expectContractValid(editor);
    focusEditor();
    caretInCell(editor, rows - 1, columns - 1);

    pressKey("Tab");
    expect(rowCount(editor)).toBe(rows);
    expectContractValid(editor);
    expect(runBlockTab(editor, "forward")).toBe(false);
  });

  it("still adds a row by Tab one row below the limit", async () => {
    const rows = NOTE_DOCUMENT_LIMITS.maxTableRows - 1;
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: tableDocument(rows, 2),
    });
    focusEditor();
    caretInCell(editor, rows - 1, 1);

    pressKey("Tab");
    expect(rowCount(editor)).toBe(NOTE_DOCUMENT_LIMITS.maxTableRows);
    expectContractValid(editor);
  });

  it("indents a list inside a cell before it moves between cells", async () => {
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: cellAttrs(),
                    content: [
                      {
                        type: "bulletList",
                        content: [
                          {
                            type: "listItem",
                            content: [
                              { type: "paragraph", content: [{ type: "text", text: "one" }] },
                            ],
                          },
                          {
                            type: "listItem",
                            content: [
                              { type: "paragraph", content: [{ type: "text", text: "two" }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  cell("right"),
                ],
              },
            ],
          },
        ],
      },
    });
    focusEditor();

    // Caret in the second list item: the innermost context wins, so Tab nests it.
    editor.commands.setTextSelection(cellPosition(editor, 0, 0) + 10);
    expect(editor.state.selection.$from.parent.textContent).toBe("two");
    pressKey("Tab");
    expect(editor.state.doc.textContent).toBe("onetworight");
    expect(editor.state.selection.$from.parent.textContent).toBe("two");
    expectContractValid(editor);

    // The nested item cannot indent again, so Tab falls through to the table.
    pressKey("Tab");
    expect(editor.state.selection.$from.parent.textContent).toBe("right");
  });
});

describe("pasted table content", () => {
  it("keeps a pasted HTML table inside the shared contract", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    editor.view.pasteHTML(
      "<table><tbody><tr><th>Metric</th><th>Value</th></tr>" +
        '<tr><td onclick="steal()" style="background:red" bgcolor="red">Revenue</td>' +
        '<td colspan="1">42</td></tr></tbody></table>',
    );

    expectContractValid(editor);
    expect(hasTable(editor)).toBe(true);
    const texts = cellTexts(editor).flat();
    expect(texts).toContain("Metric");
    expect(texts).toContain("Revenue");

    const serialized = JSON.stringify(editor.getJSON());
    expect(serialized).not.toContain("onclick");
    expect(serialized).not.toContain("background");
    expect(serialized).not.toContain("bgcolor");
  });

  it("keeps a pasted nested list inside the shared contract", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    editor.view.pasteHTML(
      "<ul><li>outer<ul><li>inner</li></ul></li></ul><ol><li>numbered</li></ol>",
    );

    expectContractValid(editor);
    const types = new Set<string>();
    editor.state.doc.descendants((node) => {
      types.add(node.type.name);
      return true;
    });
    expect(types.has("bulletList")).toBe(true);
    expect(types.has("orderedList")).toBe(true);
    expect(editor.state.doc.textContent).toContain("inner");
  });

  it("rejects unsafe pasted link hrefs while keeping safe ones", async () => {
    // The toolbar's link dialog sanitizes before applying, but paste reaches the
    // link mark's own `parseHTML`/`isAllowedUri` path instead. Both must refuse.
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    editor.view.pasteHTML(
      '<p><a href="javascript:alert(1)">bad</a> <a href="data:text/html,x">worse</a> ' +
        '<a href="https://example.test/ok">good</a></p>',
    );

    expectContractValid(editor);
    const serialized = JSON.stringify(editor.getJSON());
    expect(serialized).not.toContain("javascript:");
    expect(serialized).not.toContain("data:text/html");
    // The link text survives; only the unsafe href is refused.
    expect(editor.state.doc.textContent).toContain("bad");

    const hrefs: string[] = [];
    editor.state.doc.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === "link" && typeof mark.attrs.href === "string") {
          hrefs.push(mark.attrs.href);
        }
      }
      return true;
    });
    expect(hrefs).toEqual(["https://example.test/ok"]);
  });

  it("drops unsupported pasted nodes rather than storing them", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    editor.view.pasteHTML(
      '<div><iframe src="https://example.com"></iframe><p>kept</p><script>alert(1)</script></div>',
    );

    expectContractValid(editor);
    const serialized = JSON.stringify(editor.getJSON());
    expect(serialized).not.toContain("iframe");
    expect(serialized).not.toContain("script");
    expect(editor.state.doc.textContent).toContain("kept");
  });
});
