/**
 * The toolbar re-renders for the four things it reflects, and for nothing else.
 *
 * `useEditor` runs with `shouldRerenderOnTransaction: false`, so a transaction
 * that changes no document, no selection and no stored marks — a peer's caret
 * in a shared room, an awareness frame, the empty meta-only transaction the
 * comment decorations dispatch — must not re-render this component or re-run
 * its fifteen `editor.can()` probes.
 *
 * `activeBlockType` is the probe: `renderBlockType` calls it exactly once per
 * toolbar render, so its call count IS the render count.
 */

import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { activeBlockType } from "./toolbar-commands";

import { renderEditor } from "@/test/editor-harness";

vi.mock("./toolbar-commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toolbar-commands")>();
  return { ...actual, activeBlockType: vi.fn(actual.activeBlockType) };
});

function renderCount(): number {
  return vi.mocked(activeBlockType).mock.calls.length;
}

describe("editor toolbar re-rendering", () => {
  it("ignores a transaction that changes nothing it reflects, and follows the selection", async () => {
    const { editor, select } = await renderEditor();
    await waitFor(() =>
      expect(screen.getByRole("toolbar", { name: "Note formatting" })).toBeVisible(),
    );

    const before = renderCount();

    // No steps, no selection change: exactly the shape of an awareness frame
    // and of `refreshCommentDecorations`'s meta-only transaction.
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setMeta("notted:test-noop", true));
      await Promise.resolve();
    });
    expect(renderCount()).toBe(before);

    // A selection change does move `aria-pressed` on every mark button, so it
    // must still re-render.
    await act(async () => {
      select(1, 6);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderCount()).toBeGreaterThan(before));
  });
});
