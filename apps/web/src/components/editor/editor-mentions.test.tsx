import { safeParseNoteDocument } from "@notted/shared-validators";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { describe, expect, it, vi } from "vitest";

import { createMentionDirectory, type MentionCandidate } from "./mention-members";

import type { Editor } from "@tiptap/core";

import { renderEditor } from "@/test/editor-harness";

const ADA: MentionCandidate = {
  userId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  name: "Ada Lovelace",
  email: "ada@example.test",
  role: "admin",
};
const GRACE: MentionCandidate = {
  userId: "1f0c3b52-6ad6-4a10-9c4e-4ce0d19f2f11",
  name: "Grace Hopper",
  email: "grace@example.test",
  role: "editor",
};
const REMOVED_USER_ID = "44444444-4444-4444-8444-444444444444";

const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] };

function mentionDocument(id: string, label: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "cc " },
          { type: "mention", attrs: { id, label } },
        ],
      },
    ],
  };
}

/** `cc @Name ok` — the mention has text on *both* sides. */
function mentionDocumentWithTail(id: string, label: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "cc " },
          { type: "mention", attrs: { id, label } },
          { type: "text", text: " ok" },
        ],
      },
    ],
  };
}

function mentionPositions(editor: Editor): readonly number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "mention") positions.push(pos);
    return true;
  });
  return positions;
}

function mentionCount(editor: Editor): number {
  return mentionPositions(editor).length;
}

/** Document position immediately after the `index`-th mention atom. */
function afterMention(editor: Editor, index = 0): number {
  const position = mentionPositions(editor)[index];
  if (position === undefined) throw new Error(`no mention at index ${index}`);
  return position + 1;
}

function typeAt(editor: Editor, position: number, text: string): void {
  editor.commands.setTextSelection(position);
  editor.commands.insertContent(text);
}

function key(editor: Editor, init: KeyboardEventInit): void {
  fireEvent.keyDown(editor.view.dom, init);
}

function mentionMenu(): HTMLElement | null {
  return screen.queryByRole("listbox", { name: "Workspace members" });
}

function menuOptions(): readonly HTMLElement[] {
  const menu = mentionMenu();
  return menu === null ? [] : within(menu).queryAllByRole("option");
}

async function openMentionMenu(editor: Editor, position: number, query = ""): Promise<void> {
  typeAt(editor, position, `@${query}`);
  await waitFor(() => expect(mentionMenu()).not.toBeNull());
}

function mentionSearchOf(...members: readonly MentionCandidate[]) {
  return vi.fn((query: string): Promise<readonly MentionCandidate[]> =>
    Promise.resolve(
      members.filter((member) => member.name.toLowerCase().includes(query.toLowerCase())),
    ),
  );
}

describe("mention suggestions", () => {
  it("opens on @ and offers the injected workspace members", async () => {
    const mentionSearch = mentionSearchOf(ADA, GRACE);
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1);
    await waitFor(() => expect(menuOptions()).toHaveLength(2));
    expect(menuOptions()[0]).toHaveTextContent("Ada Lovelace");
    expect(menuOptions()[0]).toHaveTextContent("ada@example.test");
  });

  it("passes only the typed query to the injected search", async () => {
    const mentionSearch = mentionSearchOf(ADA, GRACE);
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "grace");
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
    expect(menuOptions()[0]).toHaveTextContent("Grace Hopper");
    // The search only ever receives the query. The workspace it searches is
    // fixed by the caller that built this callback, never by the query.
    for (const call of mentionSearch.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe("string");
    }
    expect(mentionSearch.mock.calls.map((call) => call[0])).toContain("grace");
  });

  it("never offers a candidate the injected search did not return", async () => {
    const mentionSearch = vi.fn((): Promise<readonly MentionCandidate[]> =>
      Promise.resolve([GRACE]),
    );
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "ada");
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
    // "Ada" matches the query but is not in the authorized result set, so it is
    // not offered: the popup has no candidate source other than the response.
    expect(menuOptions()[0]).toHaveTextContent("Grace Hopper");
    expect(mentionMenu()?.textContent).not.toContain("Ada");
  });

  it("does not open inside a code block", async () => {
    const mentionSearch = mentionSearchOf(ADA);
    const { editor } = await renderEditor({
      initialDocument: { type: "doc", content: [{ type: "codeBlock", attrs: { language: null } }] },
      mentionSearch,
    });

    typeAt(editor, 1, "@ada");
    await waitFor(() => expect(editor.state.doc.textContent).toBe("@ada"));
    expect(mentionMenu()).toBeNull();
    expect(mentionSearch).not.toHaveBeenCalled();
  });

  it("does not open when @ sits inside a word, such as an email address", async () => {
    const mentionSearch = mentionSearchOf(ADA);
    const { editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "ada" }] }],
      },
      mentionSearch,
    });

    typeAt(editor, 4, "@example");
    await waitFor(() => expect(editor.state.doc.textContent).toBe("ada@example"));
    expect(mentionMenu()).toBeNull();
  });
});

describe("mention insertion", () => {
  it("stores the stable user id and the display label", async () => {
    const mentionSearch = mentionSearchOf(ADA, GRACE);
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "ada");
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
    fireEvent.click(menuOptions()[0] as HTMLElement);

    await waitFor(() => expect(mentionMenu()).toBeNull());
    const json = editor.getJSON();
    expect(json).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: ADA.userId, label: ADA.name } },
            { type: "text", text: " " },
          ],
        },
      ],
    });
    expect(safeParseNoteDocument(json).success).toBe(true);
    // Exactly the `@query` range is replaced; no stray trigger text remains.
    expect(editor.state.doc.textContent).toBe(" ");
  });

  it("replaces only the trigger range mid-paragraph", async () => {
    const mentionSearch = mentionSearchOf(ADA);
    const { editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "ping  now" }] }],
      },
      mentionSearch,
    });

    await openMentionMenu(editor, 6, "ada");
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
    key(editor, { key: "Enter" });

    await waitFor(() => expect(mentionMenu()).toBeNull());
    // The mention replaces exactly `@ada`; the space that already followed the
    // trigger is reused as the mention's trailing space rather than doubled.
    expect(editor.state.doc.textContent).toBe("ping  now");
    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          content: [
            { type: "text", text: "ping " },
            { type: "mention", attrs: { id: ADA.userId, label: ADA.name } },
            { type: "text", text: " now" },
          ],
        },
      ],
    });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("selects with Tab rather than indenting the block", async () => {
    const mentionSearch = mentionSearchOf(ADA);
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "ada");
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
    key(editor, { key: "Tab" });

    await waitFor(() =>
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            content: [
              { type: "mention", attrs: { id: ADA.userId, label: ADA.name } },
              { type: "text", text: " " },
            ],
          },
        ],
      }),
    );
  });

  it("leaves the typed text intact on Escape", async () => {
    const mentionSearch = mentionSearchOf(ADA);
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "ada");
    key(editor, { key: "Escape" });
    await waitFor(() => expect(mentionMenu()).toBeNull());
    expect(editor.state.doc.textContent).toBe("@ada");
  });
});

describe("mention atom behaviour", () => {
  it("deletes the whole node on Backspace and nothing that follows it", async () => {
    // The mention is deliberately *not* last in the document. TipTap 2.27.1's
    // stock Backspace handler runs its replacement twice against unmapped
    // positions and eats the character after the mention as well, which is only
    // observable when something follows the mention.
    const { editor } = await renderEditor({
      initialDocument: mentionDocumentWithTail(ADA.userId, ADA.name),
    });
    // Caret directly after the mention atom.
    editor.commands.setTextSelection(afterMention(editor));
    key(editor, { key: "Backspace" });

    await waitFor(() => expect(mentionCount(editor)).toBe(0));
    expect(editor.state.doc.textContent).toBe("cc  ok");
    expect(editor.getJSON()).toMatchObject({
      content: [{ content: [{ type: "text", text: "cc  ok" }] }],
    });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("deletes exactly one of two adjacent mentions", async () => {
    const { editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: ADA.userId, label: ADA.name } },
              { type: "mention", attrs: { id: GRACE.userId, label: GRACE.name } },
              { type: "text", text: " ok" },
            ],
          },
        ],
      },
    });
    expect(mentionCount(editor)).toBe(2);

    // Caret between the two atoms: the one before the caret is the one deleted.
    editor.commands.setTextSelection(afterMention(editor, 0));
    key(editor, { key: "Backspace" });

    await waitFor(() => expect(mentionCount(editor)).toBe(1));
    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          content: [
            { type: "mention", attrs: { id: GRACE.userId, label: GRACE.name } },
            { type: "text", text: " ok" },
          ],
        },
      ],
    });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("leaves a non-empty selection to the default deletion", async () => {
    const { editor } = await renderEditor({
      initialDocument: mentionDocumentWithTail(ADA.userId, ADA.name),
    });
    // Select the leading "cc " only. The handler must decline and let
    // ProseMirror delete the selection, keeping the untouched mention.
    editor.commands.setTextSelection({ from: 1, to: 4 });
    key(editor, { key: "Backspace" });

    await waitFor(() => expect(editor.state.doc.textContent).toBe(" ok"));
    expect(mentionCount(editor)).toBe(1);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("does not throw when Backspace runs at position 0 of the document", async () => {
    const { editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [
          { type: "horizontalRule" },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      },
    });
    // The gap cursor Part 35 re-enabled can place an empty selection at 0, where
    // the handler's `anchor - 1` lookup would be a negative position.
    editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(0))));
    expect(editor.state.selection.anchor).toBe(0);

    // `keyboardShortcut` runs the keymap chain in-process, so a handler that
    // throws propagates here. Dispatching a DOM event would not: jsdom reports
    // listener exceptions to its virtual console and `dispatchEvent` returns
    // normally, which would make this expectation impossible to fail.
    expect(() => editor.commands.keyboardShortcut("Backspace")).not.toThrow();
    expect(editor.state.doc.textContent).toBe("after");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("renders as a single non-editable atom", async () => {
    const { editor } = await renderEditor({
      initialDocument: mentionDocument(ADA.userId, ADA.name),
    });
    const node = editor.view.dom.querySelector('[data-type="mention"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute("contenteditable")).toBe("false");
    expect(editor.state.doc.firstChild?.lastChild?.nodeSize).toBe(1);
  });
});

describe("mention rendering against the loaded member list", () => {
  it("shows a current member's present-day name", async () => {
    const directory = createMentionDirectory([ADA, GRACE]);
    const { editor } = await renderEditor({
      initialDocument: mentionDocument(ADA.userId, "Ada L."),
      mentionDirectory: directory,
    });

    const node = editor.view.dom.querySelector('[data-type="mention"]');
    expect(node?.getAttribute("data-mention-state")).toBe("current");
    expect(node?.textContent).toBe("@Ada Lovelace");
    // The stored label is untouched: only the rendering follows the rename.
    expect(editor.getJSON()).toMatchObject({
      content: [{ content: [{}, { attrs: { label: "Ada L." } }] }],
    });
  });

  it("renders a removed member readably with an accessible explanation", async () => {
    const directory = createMentionDirectory([ADA]);
    const { editor } = await renderEditor({
      initialDocument: mentionDocument(REMOVED_USER_ID, "Charles Babbage"),
      mentionDirectory: directory,
    });

    const node = editor.view.dom.querySelector('[data-type="mention"]');
    expect(node?.getAttribute("data-mention-state")).toBe("former");
    expect(node?.className).toContain("notted-mention--removed");
    expect(node?.textContent).toBe("@Charles Babbage (former member)");
    expect(node?.getAttribute("title")).toMatch(/no longer in this workspace/u);
    // Nothing beyond the already-stored label is disclosed.
    expect(node?.textContent).not.toContain(REMOVED_USER_ID);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("claims nothing while the member list is unavailable, then repaints", async () => {
    const directory = createMentionDirectory(null);
    const { editor } = await renderEditor({
      initialDocument: mentionDocument(REMOVED_USER_ID, "Charles Babbage"),
      mentionDirectory: directory,
    });

    const node = editor.view.dom.querySelector('[data-type="mention"]');
    expect(node?.getAttribute("data-mention-state")).toBe("unknown");
    expect(node?.textContent).toBe("@Charles Babbage");
    expect(node?.className).not.toContain("notted-mention--removed");

    // The node view subscribes, so the list arriving later repaints it.
    directory.setMembers([ADA]);
    await waitFor(() =>
      expect(
        editor.view.dom.querySelector('[data-type="mention"]')?.getAttribute("data-mention-state"),
      ).toBe("former"),
    );
  });

  it("renders without a directory at all", async () => {
    const { editor } = await renderEditor({
      initialDocument: mentionDocument(ADA.userId, ADA.name),
    });
    const node = editor.view.dom.querySelector('[data-type="mention"]');
    expect(node?.getAttribute("data-mention-state")).toBe("unknown");
    expect(node?.textContent).toBe("@Ada Lovelace");
  });
});

describe("mention lookup states", () => {
  it("shows a loading state before the first response settles", async () => {
    const pending: ((members: readonly MentionCandidate[]) => void)[] = [];
    const mentionSearch = vi.fn(
      () =>
        new Promise<readonly MentionCandidate[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    typeAt(editor, 1, "@a");
    await waitFor(() => expect(screen.getByText(/Searching workspace members/u)).toBeVisible());
    for (const resolve of pending) resolve([ADA]);
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
  });

  it("shows an empty state without throwing", async () => {
    const mentionSearch = vi.fn((): Promise<readonly MentionCandidate[]> => Promise.resolve([]));
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "nobody");
    const popover = await screen.findByTestId("notted-mention-menu");
    await waitFor(() =>
      expect(within(popover).getByText(/No workspace members match/u)).toBeInTheDocument(),
    );
    expect(menuOptions()).toHaveLength(0);
  });

  it("shows an error state when the lookup rejects", async () => {
    const mentionSearch = vi.fn((): Promise<readonly MentionCandidate[]> =>
      Promise.reject(new Error("unavailable")),
    );
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    await openMentionMenu(editor, 1, "ada");
    const popover = await screen.findByTestId("notted-mention-menu");
    await waitFor(() =>
      expect(within(popover).getByText(/could not be loaded/u)).toBeInTheDocument(),
    );
    expect(menuOptions()).toHaveLength(0);
  });

  it("ignores a slow response for a query the user has moved past", async () => {
    const pending = new Map<string, (members: readonly MentionCandidate[]) => void>();
    const mentionSearch = vi.fn(
      (query: string) =>
        new Promise<readonly MentionCandidate[]>((resolve) => {
          pending.set(query, resolve);
        }),
    );
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });

    typeAt(editor, 1, "@a");
    await waitFor(() => expect(pending.has("a")).toBe(true));
    editor.commands.insertContent("da");
    await waitFor(() => expect(pending.has("ada")).toBe(true));

    // The newer query settles first, then the older one arrives late.
    pending.get("ada")?.([ADA]);
    await waitFor(() => expect(menuOptions()).toHaveLength(1));
    pending.get("a")?.([ADA, GRACE]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menuOptions()).toHaveLength(1);
    expect(menuOptions()[0]).toHaveTextContent("Ada Lovelace");
  });

  it("announces the member count politely", async () => {
    const mentionSearch = mentionSearchOf(ADA, GRACE);
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT, mentionSearch });
    const region = screen.getByTestId("notted-mention-menu-announcement");
    expect(region).toHaveAttribute("aria-live", "polite");

    await openMentionMenu(editor, 1);
    await waitFor(() => expect(region).toHaveTextContent("2 members available."));

    editor.commands.insertContent("ada");
    await waitFor(() => expect(region).toHaveTextContent("1 member available."));
  });
});
