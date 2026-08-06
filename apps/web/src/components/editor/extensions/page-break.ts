import { NOTE_DOCUMENT_PAGE_BREAK_CLASS } from "@notted/shared-validators";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

/**
 * Explicit page break (`Notted.md` custom `PageBreak` extension, Plan Part 38).
 *
 * The node is a stateless leaf atom: *where* the break falls is its position in
 * the document, so it carries no attributes and the shared contract accepts only
 * `{ "type": "pageBreak" }`. That keeps it purely additive — no persisted schema
 * version had to change — and means there is nothing about it to migrate.
 *
 * The rendered element is a `div` carrying exactly the contract's class, not an
 * `hr`: `break-after: page` on a block box is unambiguous in every engine, an
 * `hr` would claim a thematic-separator semantic the node does not mean, and
 * `styles/print.css` plus Part 63's server-side export template both style this
 * one class. `renderDocumentHtml` emits the same markup, so an exported note
 * paginates exactly the way the editor showed it.
 *
 * Visual pagination stays separate from stored content: this node is the *only*
 * thing a page break writes to the document. The dashed guides `PageContainer`
 * paints where content simply overflows a sheet are derived measurements and
 * never become nodes.
 */

export const PAGE_BREAK_NODE_NAME = "pageBreak";

/** Shared with the contract renderer and both stylesheets. */
export const PAGE_BREAK_CLASS = NOTE_DOCUMENT_PAGE_BREAK_CLASS;

/** Accessible name for the separator, and the on-screen caption. */
export const PAGE_BREAK_LABEL = "Page break";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nottedPageBreak: {
      /** Insert a page break at the selection, keeping a block to type into. */
      setPageBreak: () => ReturnType;
    };
  }
}

/** Per-instance factory; never a module-level singleton. */
export function createPageBreakExtension() {
  return Node.create({
    name: PAGE_BREAK_NODE_NAME,
    group: "block",
    atom: true,
    selectable: true,
    // Dragging a break would move a purely positional marker by pixels rather
    // than by block, which is never what the writer meant.
    draggable: false,

    parseHTML() {
      return [
        { tag: `div.${PAGE_BREAK_CLASS}` },
        { tag: 'div[data-type="page-break"]' },
        // Word and Google Docs both export an explicit break this way.
        { tag: "div[style*='page-break-after']" },
      ];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          class: PAGE_BREAK_CLASS,
          "data-type": "page-break",
          // A separator with a name, so the break is announced rather than being
          // a silent gap. The CSS caption is decorative and cannot be relied on.
          role: "separator",
          "aria-label": PAGE_BREAK_LABEL,
        }),
      ];
    },

    addCommands() {
      return {
        setPageBreak:
          () =>
          ({ chain }) =>
            chain()
              .insertContent({ type: PAGE_BREAK_NODE_NAME })
              .command(({ tr, dispatch }) => {
                // A document ending in an atom has nowhere to put the caret, so
                // a break inserted at the very end gets a paragraph after it.
                if (tr.doc.lastChild?.type.name !== PAGE_BREAK_NODE_NAME) return true;
                if (dispatch === undefined) return true;
                const paragraph = tr.doc.type.schema.nodes.paragraph?.createAndFill();
                if (paragraph === null || paragraph === undefined) return true;
                tr.insert(tr.doc.content.size, paragraph);
                return true;
              })
              .command(({ tr, dispatch }) => {
                // `insertContent` leaves a *selectable* atom selected, which
                // makes the very next keystroke replace it: the writer inserts a
                // break, keeps typing, and the break silently disappears. Move
                // the caret into the block after it instead, which is also where
                // the writer expects to continue. Only a browser shows this —
                // calling the command directly never types the next character.
                if (dispatch === undefined) return true;
                const { selection } = tr;
                if (!(selection instanceof NodeSelection)) return true;
                if (selection.node.type.name !== PAGE_BREAK_NODE_NAME) return true;
                tr.setSelection(TextSelection.near(tr.doc.resolve(selection.to), 1));
                return true;
              })
              .run(),
      };
    },
  });
}
