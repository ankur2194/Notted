import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestAllWorkspaceMembers: vi.fn() }));
vi.mock("@/lib/notes/requests", () => mocks);

import { NoteEditorSurface } from "./NoteEditorSurface";

import type { Editor } from "@tiptap/core";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "40000000-0000-4000-8000-000000000009";
const NOTE_ID = "30000000-0000-4000-8000-000000000002";
const ADA_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const REMOVED_ID = "44444444-4444-4444-8444-444444444444";

function memberPage(workspaceId: string) {
  return {
    ok: true,
    data: {
      items: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          userId: ADA_ID,
          workspaceId,
          name: "Ada Lovelace",
          email: "ada@example.test",
          role: "admin",
          joinedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      page: 1,
      limit: 100,
      hasMore: false,
    },
  };
}

/** A member directory of `count` people, as `requestAllWorkspaceMembers` returns it. */
function memberDirectory(workspaceId: string, count: number, hasMore: boolean) {
  return {
    ok: true,
    data: {
      items: Array.from({ length: count }, (_unused, index) => {
        const id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        return {
          id,
          userId: id,
          workspaceId,
          name: `Member ${index}`,
          email: `member${index}@example.test`,
          role: "editor",
          joinedAt: "2026-08-01T00:00:00.000Z",
        };
      }),
      page: 1,
      limit: 1_000,
      hasMore,
    },
  };
}

function view(initialDocument: unknown) {
  const holder: { editor: Editor | null } = { editor: null };
  const utils = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NoteEditorSurface
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        initialDocument={initialDocument}
        editable
        ariaLabel="Note content"
        onEditorReady={(editor) => {
          if (editor !== null) holder.editor = editor;
        }}
      />
    </QueryClientProvider>,
  );
  return { ...utils, holder };
}

async function readyEditor(initialDocument: unknown): Promise<Editor> {
  const { holder } = view(initialDocument);
  await waitFor(() => expect(holder.editor).not.toBeNull());
  const editor = holder.editor;
  if (editor === null) throw new Error("editor was not created");
  return editor;
}

async function surface(): Promise<HTMLElement> {
  return waitFor(() => screen.getByRole("textbox", { name: "Note content" }));
}

describe("NoteEditorSurface member data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestAllWorkspaceMembers.mockResolvedValue(memberPage(WORKSPACE_ID));
  });

  it("offers only members returned for the note's own workspace", async () => {
    const editor = await readyEditor({ type: "doc", content: [{ type: "paragraph" }] });
    // A query that names another workspace must not change what is searched.
    editor.commands.setTextSelection(1);
    editor.commands.insertContent(`@${OTHER_WORKSPACE_ID}`);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "Workspace members" })).toBeInTheDocument(),
    );

    await waitFor(() => expect(mocks.requestAllWorkspaceMembers).toHaveBeenCalled());
    // Tenant isolation is enforced by `memberships.service.ts#listMembers`; what
    // is proven here is that the client can never point it somewhere else.
    for (const call of mocks.requestAllWorkspaceMembers.mock.calls) {
      expect(call).toEqual([WORKSPACE_ID]);
    }

    const menu = screen.getByRole("listbox", { name: "Workspace members" });
    expect(within(menu).queryAllByRole("option")).toHaveLength(0);
    expect(menu.textContent).not.toContain(OTHER_WORKSPACE_ID);
  });

  it("does not fetch the member directory for a note that stores no mention", async () => {
    await readyEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "no mentions here" }] }],
    });
    await surface();

    // Nothing to resolve, so opening the note costs no member request. The
    // listing is still fetched lazily on the first `@`, which the tenant-scope
    // and insertion tests above exercise.
    expect(mocks.requestAllWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("fetches the member directory for a note that already stores a mention", async () => {
    await readyEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: ADA_ID, label: "Ada Lovelace" } }],
        },
      ],
    });

    await waitFor(() =>
      expect(mocks.requestAllWorkspaceMembers).toHaveBeenCalledWith(WORKSPACE_ID),
    );
  });

  it("inserts a mention built from the authorized member response", async () => {
    const editor = await readyEditor({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("@ada");

    const option = await waitFor(() => {
      const menu = screen.getByRole("listbox", { name: "Workspace members" });
      const options = within(menu).getAllByRole("option");
      const first = options[0];
      if (first === undefined) throw new Error("no member option yet");
      return first;
    });
    expect(option).toHaveTextContent("Ada Lovelace");
    fireEvent.click(option);

    await waitFor(() =>
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            content: [
              { type: "mention", attrs: { id: ADA_ID, label: "Ada Lovelace" } },
              { type: "text", text: " " },
            ],
          },
        ],
      }),
    );
    expect(mocks.requestAllWorkspaceMembers).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("renders a stored mention for a current member with their present name", async () => {
    view({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "cc " },
            { type: "mention", attrs: { id: ADA_ID, label: "Ada L." } },
          ],
        },
      ],
    });
    const dom = await surface();
    await waitFor(() =>
      expect(dom.querySelector('[data-type="mention"]')?.getAttribute("data-mention-state")).toBe(
        "current",
      ),
    );
    expect(dom.querySelector('[data-type="mention"]')?.textContent).toBe("@Ada Lovelace");
  });

  it("marks a mention whose user is no longer a member as a former member", async () => {
    view({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: REMOVED_ID, label: "Charles Babbage" } }],
        },
      ],
    });
    const dom = await surface();
    await waitFor(() =>
      expect(dom.querySelector('[data-type="mention"]')?.getAttribute("data-mention-state")).toBe(
        "former",
      ),
    );
    expect(dom.querySelector('[data-type="mention"]')?.textContent).toBe(
      "@Charles Babbage (former member)",
    );
  });

  it("claims nothing about a mention when the member listing is unavailable", async () => {
    mocks.requestAllWorkspaceMembers.mockResolvedValue({ ok: false, kind: "unavailable" });
    view({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: REMOVED_ID, label: "Charles Babbage" } }],
        },
      ],
    });
    const dom = await surface();
    await waitFor(() => expect(mocks.requestAllWorkspaceMembers).toHaveBeenCalled());
    const node = dom.querySelector('[data-type="mention"]');
    expect(node?.getAttribute("data-mention-state")).toBe("unknown");
    expect(node?.textContent).toBe("@Charles Babbage");
  });
});

describe("NoteEditorSurface member directory completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches every loaded member, not only the first page's worth", async () => {
    // 250 members, i.e. three server pages unioned into one directory. The 180th
    // is exactly the member a single `page=1&limit=100` request would lose.
    mocks.requestAllWorkspaceMembers.mockResolvedValue(memberDirectory(WORKSPACE_ID, 250, false));
    const editor = await readyEditor({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("@member179");

    const option = await waitFor(() => {
      const menu = screen.getByRole("listbox", { name: "Workspace members" });
      const [first] = within(menu).getAllByRole("option");
      if (first === undefined) throw new Error("no member option yet");
      return first;
    });
    expect(option).toHaveTextContent("Member 179");
  });

  it("says a complete listing has no match, without hedging", async () => {
    mocks.requestAllWorkspaceMembers.mockResolvedValue(memberDirectory(WORKSPACE_ID, 3, false));
    const editor = await readyEditor({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("@nobodyhere");

    const popover = await screen.findByTestId("notted-mention-menu");
    await waitFor(() =>
      expect(within(popover).getByText(/No workspace members match/u)).toBeInTheDocument(),
    );
    expect(popover.textContent).not.toMatch(/loaded so far/u);
  });

  it("never implies absence from the workspace when the listing was truncated", async () => {
    mocks.requestAllWorkspaceMembers.mockResolvedValue(memberDirectory(WORKSPACE_ID, 3, true));
    const editor = await readyEditor({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("@nobodyhere");

    const popover = await screen.findByTestId("notted-mention-menu");
    await waitFor(() =>
      expect(
        within(popover).getByText(/No match among the workspace members loaded so far/u),
      ).toBeInTheDocument(),
    );
    expect(popover.textContent).toMatch(/does not mean the person is absent/u);
  });
});
