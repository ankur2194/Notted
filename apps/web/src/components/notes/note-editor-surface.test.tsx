import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

const mocks = vi.hoisted(() => ({ requestAllWorkspaceMembers: vi.fn() }));
vi.mock("@/lib/notes/requests", () => mocks);

// Part 58. Mocked at the module boundary: what this file proves is which mode
// the surface resolves to and what that does to the Part 39 save binding, not
// how a socket handshake behaves.
const collaboration = vi.hoisted(() => ({ useNoteCollaboration: vi.fn() }));
vi.mock("@/lib/collaboration/useNoteCollaboration", () => collaboration);

// Part 59, mocked for the same reason and additionally to keep this file from
// constructing the module-level Socket.io client: `useNotePresence` reaches for
// the shared socket, and a real one built here would outlive the test.
const presence = vi.hoisted(() => ({
  useNotePresence: vi.fn(() => ({
    viewers: [],
    selfPresenceId: null,
    viewerCount: 0,
    overflow: false,
  })),
}));
vi.mock("@/lib/realtime/presence-client", () => presence);

import { NoteSaveProvider, type NoteSaveHandle } from "./note-save-context";
import { NoteEditorSurface } from "./NoteEditorSurface";

import type { NoteCollaborationState } from "@/lib/collaboration/useNoteCollaboration";
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

const SOLO: NoteCollaborationState = {
  mode: "solo",
  binding: null,
  epoch: 0,
  generation: 0,
  status: "offline",
};

// Every existing test predates Part 58 and must keep behaving exactly as it
// did, which is what "solo" means: the Part 39 autosave binding, untouched.
beforeEach(() => {
  collaboration.useNoteCollaboration.mockReturnValue(SOLO);
});

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

const USER_ID = "55555555-5555-4555-8555-555555555555";

function collaborativeState(): NoteCollaborationState {
  const document = new Y.Doc();
  return {
    mode: "collaborative",
    binding: {
      document,
      awareness: new Awareness(document),
      user: { name: "Ada Lovelace", color: "#2563eb" },
    },
    epoch: 1,
    generation: 1,
    status: "synced",
  };
}

/** A save handle whose every member is observable, still typed as the real one. */
function saveSpy() {
  return {
    onDocumentChange: vi.fn(),
    onDocumentBaseline: vi.fn(),
    onDocumentRejected: vi.fn(),
    applyExternalVersion: vi.fn(),
    status: "idle",
    hasUnsavedWork: false,
  } satisfies NoteSaveHandle;
}

function collaborativeView(save: NoteSaveHandle, bindToNoteSave = true) {
  const holder: { editor: Editor | null } = { editor: null };
  const utils = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NoteSaveProvider value={save}>
        <NoteEditorSurface
          workspaceId={WORKSPACE_ID}
          noteId={NOTE_ID}
          initialDocument={{ type: "doc", content: [{ type: "paragraph" }] }}
          editable
          ariaLabel="Note content"
          userId={USER_ID}
          userName="Ada Lovelace"
          bindToNoteSave={bindToNoteSave}
          onEditorReady={(editor) => {
            if (editor !== null) holder.editor = editor;
          }}
        />
      </NoteSaveProvider>
    </QueryClientProvider>,
  );
  return { ...utils, holder };
}

async function collaborativeEditor(save: NoteSaveHandle): Promise<Editor> {
  const { holder } = collaborativeView(save);
  await waitFor(() => expect(holder.editor).not.toBeNull());
  const editor = holder.editor;
  if (editor === null) throw new Error("editor was not created");
  return editor;
}

describe("NoteEditorSurface collaboration mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestAllWorkspaceMembers.mockResolvedValue(memberPage(WORKSPACE_ID));
    collaboration.useNoteCollaboration.mockReturnValue(SOLO);
  });

  it("keeps autosave bound when the handshake resolves to solo", async () => {
    const save = saveSpy();
    const editor = await collaborativeEditor(save);

    // A timed-out or refused session degrades to exactly the Part 39 behaviour:
    // the note still saves, through the same machine, with the same baseline.
    expect(save.onDocumentBaseline).toHaveBeenCalled();
    editor.commands.insertContent("typed while solo");
    await waitFor(() => expect(save.onDocumentChange).toHaveBeenCalled());
  });

  it("unbinds autosave once the session is collaborative", async () => {
    collaboration.useNoteCollaboration.mockReturnValue(collaborativeState());
    const save = saveSpy();
    const editor = await collaborativeEditor(save);

    editor.commands.insertContent({
      type: "paragraph",
      content: [{ type: "text", text: "typed while collaborating" }],
    });
    await waitFor(() => expect(editor.getText()).toContain("typed while collaborating"));

    // One writer at a time: the API's projection owns `notes.content` while the
    // session is live, so this editor publishes neither baseline nor changes.
    expect(save.onDocumentChange).not.toHaveBeenCalled();
    expect(save.onDocumentBaseline).not.toHaveBeenCalled();
  });

  it("renders a skeleton rather than an editor while the handshake is pending", () => {
    collaboration.useNoteCollaboration.mockReturnValue({
      mode: "pending",
      binding: null,
      epoch: 0,
      generation: 0,
      status: "connecting",
    } satisfies NoteCollaborationState);
    collaborativeView(saveSpy());

    expect(screen.getByTestId("note-collaboration-pending")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();
  });

  it("never opens a session for a read-only historical preview", () => {
    collaborativeView(saveSpy(), false);

    expect(collaboration.useNoteCollaboration).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, workspaceId: WORKSPACE_ID, noteId: NOTE_ID }),
    );
  });
});
