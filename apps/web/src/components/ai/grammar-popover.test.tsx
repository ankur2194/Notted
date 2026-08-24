import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GrammarPopover } from "./GrammarPopover";

import type { GrammarSuggestionView } from "./useGrammarCheck";
import type { Editor } from "@tiptap/core";

import { GRAMMAR_SUGGESTION_ID_ATTRIBUTE } from "@/components/editor/extensions/grammar-decorations";

/**
 * Part 70 — which suggestion the author is looking at, and what happens when
 * the one they clicked is no longer there.
 *
 * The hook is NOT mocked at a module boundary here because this component never
 * imports it at runtime: `accept`, `dismiss`, and `getSuggestion` arrive as
 * props, so the seam is the prop list itself. What the editor contributes is a
 * real DOM subtree — the underlines are ProseMirror decorations, so the only
 * thing this component can hit-test is the element.
 */

const SUGGESTION: GrammarSuggestionView = {
  id: "s1",
  message: "Consider “their” instead of “there”.",
  replacement: "their",
  originalText: "there",
  category: "grammar",
};

/** The editing surface, with two decorated spans and one plain word. */
function mountSurface(): HTMLElement {
  const dom = document.createElement("div");
  dom.setAttribute("contenteditable", "true");
  // jsdom does not derive focusability from `contenteditable`; the real surface
  // is focusable, and the focus-return assertion is about this component.
  dom.tabIndex = 0;
  dom.innerHTML = `<p>It is <span ${GRAMMAR_SUGGESTION_ID_ATTRIBUTE}="s1">there</span> book, <span ${GRAMMAR_SUGGESTION_ID_ATTRIBUTE}="gone">stale</span> word.</p>`;
  document.body.appendChild(dom);
  return dom;
}

function fakeEditor(dom: HTMLElement, caret?: Node): Editor {
  return {
    isDestroyed: false,
    state: { selection: { from: 3 } },
    view: { dom, domAtPos: () => ({ node: caret ?? dom, offset: 0 }) },
  } as unknown as Editor;
}

const accept = vi.fn();
const dismiss = vi.fn();
const getSuggestion = vi.fn<(id: string) => GrammarSuggestionView | null>();

function renderPopover(dom: HTMLElement, caret?: Node) {
  return render(
    <GrammarPopover
      editor={fakeEditor(dom, caret)}
      getSuggestion={getSuggestion}
      accept={accept}
      dismiss={dismiss}
    />,
  );
}

function span(dom: HTMLElement, id: string): HTMLElement {
  const element = dom.querySelector<HTMLElement>(`[${GRAMMAR_SUGGESTION_ID_ATTRIBUTE}="${id}"]`);
  if (element === null) throw new Error(`no decorated span ${id}`);
  return element;
}

beforeEach(() => {
  // "gone" is the suggestion that has already been accepted, dismissed, or
  // invalidated by an edit: the underline is still on screen for one frame.
  getSuggestion.mockImplementation((id) => (id === "s1" ? SUGGESTION : null));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("GrammarPopover", () => {
  it("renders nothing until a decorated span is clicked", () => {
    const dom = mountSurface();
    renderPopover(dom);

    expect(screen.queryByTestId("grammar-popover")).toBeNull();
  });

  it("opens on a decorated span with the message and the replacement", async () => {
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "s1"));

    const popover = screen.getByTestId("grammar-popover");
    expect(popover).toHaveAttribute("role", "dialog");
    expect(popover).toHaveAccessibleName("Grammar suggestion");
    expect(screen.getByTestId("grammar-popover-message")).toHaveTextContent(SUGGESTION.message);
    const change = screen.getByTestId("grammar-popover-change");
    expect(change).toHaveTextContent("there");
    expect(change).toHaveTextContent("their");
    // Focus moves in, so Escape and Tab behave as they do in any dialog.
    expect(popover).toHaveFocus();
  });

  it("accepts through the hook and closes", async () => {
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "s1"));
    await userEvent.click(screen.getByTestId("grammar-accept"));

    expect(accept).toHaveBeenCalledWith("s1");
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.queryByTestId("grammar-popover")).toBeNull();
  });

  it("dismisses through the hook and closes", async () => {
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "s1"));
    await userEvent.click(screen.getByTestId("grammar-dismiss"));

    expect(dismiss).toHaveBeenCalledWith("s1");
    expect(accept).not.toHaveBeenCalled();
    expect(screen.queryByTestId("grammar-popover")).toBeNull();
  });

  it("closes on Escape and puts focus back on the editor", async () => {
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "s1"));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId("grammar-popover")).toBeNull();
    expect(dom).toHaveFocus();
    // Escape is a cancel, not a decision.
    expect(accept).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("closes when the click lands outside the popover", async () => {
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "s1"));
    await userEvent.click(document.body);

    expect(screen.queryByTestId("grammar-popover")).toBeNull();
  });

  it("opens nothing for a suggestion that has already gone", async () => {
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "gone"));

    expect(getSuggestion).toHaveBeenCalledWith("gone");
    expect(screen.queryByTestId("grammar-popover")).toBeNull();
  });

  it("offers a removal rather than a blank replacement when the fix is a deletion", async () => {
    getSuggestion.mockImplementation(() => ({ ...SUGGESTION, replacement: "" }));
    const dom = mountSurface();
    renderPopover(dom);

    await userEvent.click(span(dom, "s1"));

    expect(screen.getByTestId("grammar-popover-change")).toHaveTextContent("Remove this text");
    expect(screen.getByTestId("grammar-accept")).toHaveTextContent("Remove");
  });

  it("opens from the keyboard on the caret's own underline, and leaves typing keys alone", async () => {
    const dom = mountSurface();
    const caret = span(dom, "s1").firstChild;
    renderPopover(dom, caret ?? undefined);

    dom.focus();
    // Enter and Space must never be claimed: they are how a writer types.
    await userEvent.keyboard("{Enter} ");
    expect(screen.queryByTestId("grammar-popover")).toBeNull();

    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(screen.getByTestId("grammar-popover")).toBeInTheDocument();
  });
});
