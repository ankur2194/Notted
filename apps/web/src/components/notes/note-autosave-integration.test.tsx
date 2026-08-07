import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateNote: vi.fn(),
  requestAllWorkspaceMembers: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/notes/requests", () => mocks);

import { NoteEditorSurface } from "./NoteEditorSurface";
import { PageContainer } from "./PageContainer";

import type { PageSize } from "@notted/shared-types";
import type { NoteDocument } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";

import { AUTOSAVE_DEBOUNCE_MS } from "@/lib/notes/autosave-machine";
import { HELLO_DOCUMENT, renderEditor } from "@/test/editor-harness";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const NOTE_ID = "30000000-0000-4000-8000-000000000002";

/** Longer than the debounce, so a save that never comes is a real absence. */
const SETTLE_MS = AUTOSAVE_DEBOUNCE_MS * 3;

function updated(version: number, pageSize: PageSize = "a4") {
  return { ok: true, data: { note: { pageSize, version } } };
}

/**
 * The real note page: a Server-Component-shaped tree where `PageContainer` owns
 * the autosave machine and the editor reaches it only through context.
 */
async function openNote(initialDocument: unknown = HELLO_DOCUMENT): Promise<Editor> {
  const holder: { editor: Editor | null } = { editor: null };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PageContainer
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        initialPageSize="a4"
        initialVersion={3}
        canUpdate
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
      </PageContainer>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(holder.editor).not.toBeNull());
  const editor = holder.editor;
  if (editor === null) throw new Error("editor was not created");
  return editor;
}

function savedContent(): NoteDocument {
  const call = mocks.updateNote.mock.calls.at(-1);
  return (call?.[2] as { content: NoteDocument }).content;
}

function plainText(document: NoteDocument): string {
  return JSON.stringify(document);
}

/**
 * Push the editor past the note contract's top-level child limit, so its own
 * serialization stops validating and `onDocumentChange` is deliberately not
 * called. Without a rejection signal autosave would simply go quiet while the
 * writer kept typing.
 */
function rejectDocument(editor: Editor): void {
  editor.commands.insertContent(
    Array.from({ length: 260 }, () => ({ type: "paragraph" as const })),
  );
}

describe("note autosave through the real editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateNote.mockReset();
    mocks.updateNote.mockResolvedValue(updated(4));
    mocks.requestAllWorkspaceMembers.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
    window.localStorage.clear();
  });

  it("carries a real editor change through the machine to one update request", async () => {
    const editor = await openNote();
    expect(screen.getByTestId("note-save-status")).toHaveTextContent("No unsaved changes.");

    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" and more");
    });

    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    const [workspaceId, noteId, input, options] = mocks.updateNote.mock.calls[0] ?? [];
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(noteId).toBe(NOTE_ID);
    expect(input).toMatchObject({ expectedVersion: 3 });
    expect(options).toEqual({ keepalive: false });
    expect(plainText(savedContent())).toContain("and more");

    await waitFor(() => expect(screen.getByTestId("note-save-status")).toHaveTextContent("Saved."));
  });

  it("issues nothing when a real edit is undone back to what was loaded", async () => {
    const editor = await openNote();

    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent("!");
    });
    await waitFor(() =>
      expect(screen.getByTestId("note-save-status")).toHaveTextContent("Unsaved changes."),
    );

    act(() => {
      editor.commands.undo();
    });

    // The editor's own serialization was taken as the baseline when it opened,
    // so a document round-tripped back to the loaded value is not a change even
    // though ProseMirror fills in attributes the stored contract omits.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
    expect(mocks.updateNote).not.toHaveBeenCalled();
    expect(screen.getByTestId("note-save-status")).toHaveTextContent("No unsaved changes.");
  });

  it("opens a Part 42 image note clean, even though Part 43 fills in four defaults", async () => {
    // The single most dangerous failure mode of the Part 43 widening.
    //
    // ProseMirror writes every DECLARED attribute into `getJSON()`, so opening a
    // document stored before Part 43 produces JSON carrying `align`, `wrap`,
    // `fullWidth`, and `caption` that the stored document never had. Two things
    // have to hold, and both are asserted here:
    //
    // 1. `safeParseNoteDocument` accepts that output. If it did not,
    //    `onDocumentChange` would never fire again and autosave would go silent
    //    for the whole session with nothing on screen to explain it.
    // 2. The baseline is the editor's OWN serialization, so the added defaults
    //    are not mistaken for an edit. Otherwise every note containing an image
    //    would issue a pointless save the instant it was opened.
    await openNote({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Figure below." }] },
        {
          type: "image",
          attrs: {
            attachmentId: "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607",
            alt: "A chart",
            width: 1200,
            height: 800,
          },
        },
      ],
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
    expect(mocks.updateNote).not.toHaveBeenCalled();
    expect(screen.getByTestId("note-save-status")).toHaveTextContent("No unsaved changes.");
  });

  it("saves an image resize through the one existing save call site", async () => {
    const editor = await openNote({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            attachmentId: "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607",
            alt: "A chart",
            width: 400,
            height: 200,
          },
        },
      ],
    });

    act(() => {
      let target = -1;
      editor.state.doc.descendants((node, pos) => {
        if (target === -1 && node.type.name === "image") target = pos;
        return target === -1;
      });
      editor.commands.setNodeSelection(target);
      editor.commands.nottedResizeSelectedImage(32);
    });

    // No new save call site: a resize is an ordinary transaction that takes the
    // same route a typed character takes.
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(plainText(savedContent())).toContain('"width":432');
  });

  it("coalesces a page-size press and pending text into a single request", async () => {
    const editor = await openNote();
    mocks.updateNote.mockResolvedValue(updated(4, "letter"));

    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" body");
    });
    await waitFor(() =>
      expect(screen.getByTestId("note-save-status")).toHaveTextContent("Unsaved changes."),
    );

    act(() => {
      screen.getByRole("button", { name: "US Letter" }).click();
    });

    // One PATCH, one `expectedVersion`: the API bumps `version` on every update,
    // so two independent requests would invalidate each other.
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(1));
    expect(mocks.updateNote.mock.calls[0]?.[2]).toMatchObject({
      expectedVersion: 3,
      pageSize: "letter",
    });
    expect(plainText(savedContent())).toContain("body");
  });

  it("announces a contract rejection exactly once on the hosted page", async () => {
    const editor = await openNote();

    act(() => {
      editor.commands.focus("end");
      rejectDocument(editor);
    });

    // One event, one assertive announcement. `SaveStatusIndicator` owns it
    // because it is the message that states the consequence — nothing saves
    // until the change is undone — and the editor stands down.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe(screen.getByTestId("note-save-rejected"));
    expect(alerts[0]).toHaveTextContent(/does not allow/u);
  });
});

describe("TiptapEditor Part 39 seams", () => {
  it("reports contract-valid output and clears the rejection flag with it", async () => {
    const changes: NoteDocument[] = [];
    const rejections: boolean[] = [];
    const { editor } = await renderEditor({
      onDocumentChange: (document) => changes.push(document),
      onDocumentRejected: (rejected) => rejections.push(rejected),
    });

    act(() => {
      editor.commands.focus("end");
      editor.commands.insertContent(" more");
    });

    expect(changes.length).toBeGreaterThan(0);
    expect(rejections.at(-1)).toBe(false);
    expect(JSON.stringify(changes.at(-1))).toContain("more");
  });

  it("reports a rejection instead of silently dropping the change", async () => {
    const changes: NoteDocument[] = [];
    const rejections: boolean[] = [];
    const { editor } = await renderEditor({
      onDocumentChange: (document) => changes.push(document),
      onDocumentRejected: (rejected) => rejections.push(rejected),
    });
    const before = changes.length;

    act(() => {
      rejectDocument(editor);
    });

    expect(rejections.at(-1)).toBe(true);
    expect(changes.length).toBe(before);
    // A host is listening, so it owns the announcement: exactly one assertive
    // message per rejection, and this component contributes none.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("raises its own single alert when no host is listening for rejections", async () => {
    const { editor } = await renderEditor();

    act(() => {
      rejectDocument(editor);
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/the note contract rejects/u);
  });

  /**
   * `useNoteSave` returns a no-op handle without a provider, so a defined
   * callback does not prove a host exists. If the editor suppressed its alert
   * on that alone, a rejection would be announced nowhere in the two
   * configurations that render no save UI.
   */
  it("still announces a rejection when the surface has no save host", async () => {
    const holder: { editor: Editor | null } = { editor: null };
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NoteEditorSurface
          workspaceId={WORKSPACE_ID}
          noteId={NOTE_ID}
          initialDocument={HELLO_DOCUMENT}
          editable
          ariaLabel="Note content"
          onEditorReady={(editor) => {
            if (editor !== null) holder.editor = editor;
          }}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(holder.editor).not.toBeNull());
    const editor = holder.editor;
    if (editor === null) throw new Error("editor was not created");

    act(() => {
      rejectDocument(editor);
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/the note contract rejects/u);
  });
});
