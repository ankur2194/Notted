"use client";

import { NodeSelection } from "@tiptap/pm/state";
import { useCallback, useEffect, useState } from "react";

import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface SelectedNodeState {
  readonly pos: number;
  readonly node: ProseMirrorNode;
  /** Viewport rect of the node's DOM. Zero-sized where there is no layout. */
  readonly rect: DOMRect | null;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * Track a `NodeSelection` on one node type, with the selected node's viewport
 * rect (Part 43).
 *
 * Written generically rather than as `useSelectedImage` because Part 44's
 * attachment card needs exactly this: "is a node of type X selected, and where
 * is it on screen" is the whole precondition for any contextual chrome attached
 * to an atom node.
 *
 * The rect is **viewport-relative and already scaled**: `PageContainer` renders
 * the sheet inside a `transform: scale()`, and `getBoundingClientRect()` reports
 * a transformed element in scaled viewport space. That is exactly the space a
 * `position: fixed` toolbar is positioned in, so nothing is divided by the zoom
 * — the same finding Part 42 recorded for drop coordinates.
 *
 * State is only replaced when something a consumer can see actually changed, so
 * an ordinary keystroke somewhere else in the document does not re-render the
 * chrome on every transaction.
 */
export function useSelectedNode(editor: Editor | null, typeName: string): SelectedNodeState | null {
  const [state, setState] = useState<SelectedNodeState | null>(null);

  const read = useCallback((): SelectedNodeState | null => {
    if (editor === null || editor.isDestroyed) return null;
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection)) return null;
    if (selection.node.type.name !== typeName) return null;
    const dom = editor.view.nodeDOM(selection.from);
    return {
      pos: selection.from,
      node: selection.node,
      rect: dom instanceof HTMLElement ? dom.getBoundingClientRect() : null,
    };
  }, [editor, typeName]);

  const sync = useCallback((): void => {
    setState((previous) => {
      const next = read();
      if (previous === null || next === null) return previous === next ? previous : next;
      if (
        previous.pos === next.pos &&
        previous.node === next.node &&
        sameRect(previous.rect, next.rect)
      ) {
        return previous;
      }
      return next;
    });
  }, [read]);

  useEffect(() => {
    if (editor === null) {
      setState(null);
      return;
    }
    sync();
    editor.on("transaction", sync);
    editor.on("selectionUpdate", sync);
    return () => {
      editor.off("transaction", sync);
      editor.off("selectionUpdate", sync);
    };
  }, [editor, sync]);

  // Scrolling the page viewport or resizing the window moves the node without
  // producing a transaction, so the rect has to be re-read from the DOM.
  // `capture: true` is required: the paper scrolls inside `.notted-page-viewport`,
  // and a scroll event on a nested element does not bubble to `window`.
  useEffect(() => {
    if (editor === null) return;
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [editor, sync]);

  return state;
}
