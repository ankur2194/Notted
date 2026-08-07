import { safeParseNoteDocument } from "@notted/shared-validators";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Editor } from "@tiptap/core";

import { renderEditor } from "@/test/editor-harness";

/**
 * MSW is not installed in this project, so the network boundary is mocked at the
 * module the component actually imports.
 *
 * `vi.hoisted` is required because `vi.mock` is hoisted above the imports: a spy
 * declared with a plain `const` would still be in its temporal dead zone when
 * the factory runs.
 */
const requests = vi.hoisted(() => ({
  deleteAttachment: vi.fn(),
  attachmentContentUrl: vi.fn(),
}));

vi.mock("@/lib/notes/attachment-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/attachment-requests")>();
  return { ...actual, ...requests };
});

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CONTENT_URL = `https://api.test/api/v1/workspaces/${WORKSPACE_ID}/attachments/${ATTACHMENT_ID}/content?variant=full`;

function attachmentNode(attrs: Record<string, unknown> = {}) {
  return {
    type: "attachment",
    attrs: {
      attachmentId: ATTACHMENT_ID,
      name: "quarterly-report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 245_760,
      ...attrs,
    },
  };
}

function attachmentDocument(attrs: Record<string, unknown> = {}) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      attachmentNode(attrs),
    ],
  };
}

function attachmentCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "attachment") count += 1;
    return true;
  });
  return count;
}

function removeButton(): HTMLElement {
  const button = document.querySelector('[data-testid="attachment-remove"]');
  if (!(button instanceof HTMLElement)) throw new Error("no delete control on the card");
  return button;
}

beforeEach(() => {
  // `vi.clearAllMocks()` resets call history but keeps queued one-shot
  // implementations, so a `mockResolvedValueOnce` from a previous test would
  // leak into the next one. `mockReset` is the only form that drops them.
  requests.deleteAttachment.mockReset();
  requests.attachmentContentUrl.mockReset();
  requests.attachmentContentUrl.mockReturnValue(CONTENT_URL);
});

describe("attachment delete confirmation", () => {
  it("asks before destroying a file, and destroys nothing until confirmed", async () => {
    const { editor } = await renderEditor({
      initialDocument: attachmentDocument(),
      workspaceId: WORKSPACE_ID,
    });

    fireEvent.click(removeButton());

    expect(await screen.findByText("Delete this file?")).toBeInTheDocument();
    // Nothing has happened yet: no request, and the card is still in the note.
    expect(requests.deleteAttachment).not.toHaveBeenCalled();
    expect(attachmentCount(editor)).toBe(1);
  });

  it("deletes server-side FIRST, then removes the node", async () => {
    requests.deleteAttachment.mockResolvedValue({
      ok: true,
      data: { id: ATTACHMENT_ID, deleted: true },
    });
    const { editor } = await renderEditor({
      initialDocument: attachmentDocument(),
      workspaceId: WORKSPACE_ID,
    });

    fireEvent.click(removeButton());
    fireEvent.click(await screen.findByTestId("attachment-delete-confirm"));

    await waitFor(() => expect(attachmentCount(editor)).toBe(0));
    expect(requests.deleteAttachment).toHaveBeenCalledWith(WORKSPACE_ID, ATTACHMENT_ID);
    // The node removal is an ordinary editor transaction, so the document that
    // reaches autosave is still contract-valid.
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    await waitFor(() => expect(screen.queryByText("Delete this file?")).not.toBeInTheDocument());
  });

  it("keeps the card and says so when the server refuses", async () => {
    // The failure that matters: removing the node first would leave the file in
    // storage referenced by nothing, silently costing the workspace quota.
    requests.deleteAttachment.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    const { editor } = await renderEditor({
      initialDocument: attachmentDocument(),
      workspaceId: WORKSPACE_ID,
    });

    fireEvent.click(removeButton());
    fireEvent.click(await screen.findByTestId("attachment-delete-confirm"));

    const alert = await screen.findByTestId("attachment-delete-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.textContent).toContain("still attached to the note");
    expect(attachmentCount(editor)).toBe(1);
  });

  it("removes every card referencing the same deleted file", async () => {
    // Once the bytes are gone both cards are dead; leaving one behind would show
    // a permanent "unavailable" card the writer never chose to keep.
    requests.deleteAttachment.mockResolvedValue({
      ok: true,
      data: { id: ATTACHMENT_ID, deleted: true },
    });
    const twice = {
      type: "doc",
      content: [
        attachmentNode(),
        { type: "paragraph", content: [{ type: "text", text: "between" }] },
        attachmentNode(),
      ],
    };
    const { editor } = await renderEditor({
      initialDocument: twice,
      workspaceId: WORKSPACE_ID,
    });
    expect(attachmentCount(editor)).toBe(2);

    fireEvent.click(removeButton());
    fireEvent.click(await screen.findByTestId("attachment-delete-confirm"));

    await waitFor(() => expect(attachmentCount(editor)).toBe(0));
    expect(requests.deleteAttachment).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toContain("between");
  });

  it("offers no delete at all on a read-only note", async () => {
    const { editor } = await renderEditor({
      initialDocument: attachmentDocument(),
      editable: false,
      workspaceId: WORKSPACE_ID,
    });

    expect(removeButton().hidden).toBe(true);
    expect(attachmentCount(editor)).toBe(1);
    expect(requests.deleteAttachment).not.toHaveBeenCalled();
  });
});

describe("attachment card download", () => {
  it("points the download at the authorized content route once metadata is known", async () => {
    await renderEditor({
      initialDocument: attachmentDocument(),
      workspaceId: WORKSPACE_ID,
    });

    const download = document.querySelector('[data-testid="attachment-download"]');
    expect(download).toBeInstanceOf(HTMLAnchorElement);
    // With no directory supplied the metadata is unresolved, so no bytes may be
    // requested: the control is present but disabled and out of the tab order.
    expect(download).not.toHaveAttribute("href");
    expect(download).toHaveAttribute("aria-disabled", "true");
  });
});
