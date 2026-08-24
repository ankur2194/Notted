import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Part 69 — what the tag suggestion surface does, and above all what it does NOT
 * do before the author confirms.
 *
 * Every transport is mocked at its module boundary: `@/lib/ai/requests`,
 * `@/lib/tags/requests`, and `@/lib/notes/requests` are proved by their own
 * suites, and what this file is about is the ordering — suggest, confirm, create,
 * re-read, union, write — which is entirely this component's.
 */
const aiRequests = vi.hoisted(() => ({
  fetchAiStatus: vi.fn(),
  requestTagSuggestions: vi.fn(),
}));
vi.mock("@/lib/ai/requests", () => aiRequests);

const tagRequests = vi.hoisted(() => ({ createTag: vi.fn(), requestTagPage: vi.fn() }));
vi.mock("@/lib/tags/requests", () => tagRequests);

const noteRequests = vi.hoisted(() => ({ requestNoteDetail: vi.fn(), updateNote: vi.fn() }));
vi.mock("@/lib/notes/requests", () => noteRequests);

import { TagSuggestions } from "./TagSuggestions";

import type { Editor } from "@tiptap/core";

import { AI_FAILURE_MESSAGES } from "@/lib/ai/stream";

const WORKSPACE_ID = "40000000-0000-4000-8000-000000000001";
const NOTE_ID = "40000000-0000-4000-8000-000000000002";
/** Already on the note, and not suggested: it must survive the full replace. */
const TAG_ALREADY = "40000000-0000-4000-8000-00000000000a";
/** Suggested as existing AND already on the note: the dedupe case. */
const TAG_ROADMAP = "40000000-0000-4000-8000-00000000000b";
const TAG_DESIGN = "40000000-0000-4000-8000-00000000000c";
/** What `createTag` hands back for a confirmed proposal. */
const TAG_CREATED = "40000000-0000-4000-8000-00000000000d";
/** What the 409 fallback finds instead. */
const TAG_RESOLVED = "40000000-0000-4000-8000-00000000000e";

const NOTE_TEXT = "Roadmap for the third quarter.";

function statusResult(enabled: boolean) {
  return {
    ok: true,
    data: {
      enabled,
      provider: enabled ? "openai" : "disabled",
      model: enabled ? "gpt-4o-mini" : null,
    },
  };
}

const SUGGESTIONS = {
  ok: true,
  data: {
    existing: [
      { tagId: TAG_ROADMAP, name: "roadmap" },
      { tagId: TAG_DESIGN, name: "design" },
    ],
    proposed: [{ name: "q3-planning" }],
  },
};

/** Enough editor for `textBetween(0, size, "\n\n", " ")`. */
function fakeEditor(text = NOTE_TEXT): Editor {
  return {
    state: {
      selection: { from: 1, to: 1 },
      doc: { content: { size: text.length + 2 }, textBetween: () => text },
    },
  } as unknown as Editor;
}

function renderSuggestions(options: { editable?: boolean; editor?: Editor | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TagSuggestions
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        editor={options.editor === undefined ? fakeEditor() : options.editor}
        editable={options.editable ?? true}
      />
    </QueryClientProvider>,
  );
}

/** Ask for suggestions and wait for the two groups to land. */
async function suggest(): Promise<void> {
  const button = await screen.findByTestId("ai-suggest-tags");
  await userEvent.click(button);
  await screen.findByTestId("note-tag-suggestions-existing");
}

beforeEach(() => {
  aiRequests.fetchAiStatus.mockResolvedValue(statusResult(true));
  aiRequests.requestTagSuggestions.mockResolvedValue(SUGGESTIONS);
  tagRequests.createTag.mockResolvedValue({ ok: true, data: { tag: { id: TAG_CREATED } } });
  tagRequests.requestTagPage.mockResolvedValue({ ok: true, data: { items: [] } });
  noteRequests.requestNoteDetail.mockResolvedValue({
    ok: true,
    // The note already carries two tags, one of which is also suggested.
    data: { tagIds: [TAG_ALREADY, TAG_ROADMAP], version: 7 },
  });
  noteRequests.updateNote.mockResolvedValue({ ok: true, data: { note: { id: NOTE_ID } } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TagSuggestions", () => {
  it("renders nothing at all when the note is not editable", () => {
    const { container } = renderSuggestions({ editable: false });
    expect(container).toBeEmptyDOMElement();
    expect(aiRequests.fetchAiStatus).not.toHaveBeenCalled();
  });

  it("explains itself and offers no suggest action when AI is disabled", async () => {
    aiRequests.fetchAiStatus.mockResolvedValue(statusResult(false));
    renderSuggestions();

    const explanation = await screen.findByTestId("note-tag-suggestions-unavailable");
    expect(explanation).toHaveTextContent(AI_FAILURE_MESSAGES.AI_DISABLED);
    expect(screen.queryByTestId("ai-suggest-tags")).toBeNull();
    expect(aiRequests.requestTagSuggestions).not.toHaveBeenCalled();
  });

  it("refuses an empty note in copy instead of spending a provider call", async () => {
    renderSuggestions({ editor: fakeEditor("   ") });

    await userEvent.click(await screen.findByTestId("ai-suggest-tags"));

    expect(screen.getByTestId("note-tag-suggestions-status")).toHaveTextContent(
      /nothing to tag yet/iu,
    );
    expect(aiRequests.requestTagSuggestions).not.toHaveBeenCalled();
  });

  it("separates existing tags from tags that would be created", async () => {
    renderSuggestions();
    await suggest();

    expect(aiRequests.requestTagSuggestions).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { noteId: NOTE_ID, content: NOTE_TEXT },
      expect.objectContaining({ signal: expect.anything() }),
    );

    const existing = screen.getByRole("group", { name: "Existing tags" });
    const proposed = screen.getByRole("group", { name: "New tags (will be created)" });
    expect(existing).not.toBe(proposed);

    // Each suggestion sits in exactly one of the two groups.
    expect(within(existing).getByRole("button", { name: "roadmap" })).toBeInTheDocument();
    expect(within(existing).queryByRole("button", { name: /q3-planning/u })).toBeNull();
    expect(within(proposed).getByRole("button", { name: /q3-planning/u })).toBeInTheDocument();

    // The "these do not exist yet" distinction is carried by text, not by the
    // dashed border alone.
    expect(within(proposed).getByRole("button", { name: /will be created/u })).toBeInTheDocument();

    // Nothing is pre-selected: the author confirms. Three chips, none pressed.
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(3);
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
  });

  it("creates nothing and assigns nothing before Apply is pressed", async () => {
    renderSuggestions();
    await suggest();

    // Selecting chips is not confirming them.
    await userEvent.click(screen.getByRole("button", { name: "roadmap" }));
    await userEvent.click(screen.getByRole("button", { name: /q3-planning/u }));
    expect(screen.getByRole("button", { name: "roadmap" })).toHaveAttribute("aria-pressed", "true");

    expect(tagRequests.createTag).not.toHaveBeenCalled();
    expect(noteRequests.updateNote).not.toHaveBeenCalled();
    expect(noteRequests.requestNoteDetail).not.toHaveBeenCalled();
  });

  it("unions the confirmed ids with the note's current tags, deduped and ordered", async () => {
    renderSuggestions();
    await suggest();

    // "roadmap" is already on the note; "design" is left unselected on purpose.
    await userEvent.click(screen.getByRole("button", { name: "roadmap" }));
    await userEvent.click(screen.getByRole("button", { name: /q3-planning/u }));
    await userEvent.click(screen.getByTestId("ai-apply-tags"));

    await waitFor(() => expect(noteRequests.updateNote).toHaveBeenCalledTimes(1));

    // Read immediately before the write — a version captured earlier would lose
    // the CAS against Part 39 autosave.
    expect(noteRequests.requestNoteDetail).toHaveBeenCalledWith(WORKSPACE_ID, NOTE_ID);
    expect(noteRequests.updateNote).toHaveBeenCalledWith(WORKSPACE_ID, NOTE_ID, {
      expectedVersion: 7,
      // The note's own tags first, in their existing order; the created tag
      // appended; "roadmap" present once; the unselected "design" absent.
      tagIds: [TAG_ALREADY, TAG_ROADMAP, TAG_CREATED],
    });

    expect(screen.getByTestId("note-tag-suggestions-status")).toHaveTextContent(/1 newly created/u);
  });

  it("reuses the existing tag when creating a proposed name conflicts", async () => {
    tagRequests.createTag.mockResolvedValue({
      ok: false,
      kind: "conflict",
      code: "TAG_NAME_TAKEN",
    });
    tagRequests.requestTagPage.mockResolvedValue({
      ok: true,
      // Different case on purpose: the server matches names case-insensitively.
      data: { items: [{ id: TAG_RESOLVED, name: "Q3-Planning" }] },
    });

    renderSuggestions();
    await suggest();

    await userEvent.click(screen.getByRole("button", { name: /q3-planning/u }));
    await userEvent.click(screen.getByTestId("ai-apply-tags"));

    await waitFor(() => expect(noteRequests.updateNote).toHaveBeenCalledTimes(1));

    // The conflict is resolved by lookup, never by hammering create again.
    expect(tagRequests.createTag).toHaveBeenCalledTimes(1);
    expect(tagRequests.requestTagPage).toHaveBeenCalledWith(WORKSPACE_ID, {
      page: 1,
      limit: 50,
      name: "q3-planning",
      sortBy: "name",
      sortDirection: "asc",
    });
    expect(noteRequests.updateNote).toHaveBeenCalledWith(WORKSPACE_ID, NOTE_ID, {
      expectedVersion: 7,
      tagIds: [TAG_ALREADY, TAG_ROADMAP, TAG_RESOLVED],
    });
  });

  it("offers a retry rather than a silent loss when the note changed under the write", async () => {
    noteRequests.updateNote.mockResolvedValue({ ok: false, kind: "version-conflict" });

    renderSuggestions();
    await suggest();

    await userEvent.click(screen.getByRole("button", { name: "design" }));
    await userEvent.click(screen.getByTestId("ai-apply-tags"));

    await waitFor(() =>
      expect(screen.getByTestId("note-tag-suggestions-status")).toHaveTextContent(
        /Press Apply again/u,
      ),
    );
    // The proposal survives, so pressing Apply again re-reads and retries.
    expect(screen.getByRole("button", { name: "design" })).toHaveAttribute("aria-pressed", "true");
  });

  it("refuses an empty confirmation without touching anything", async () => {
    renderSuggestions();
    await suggest();

    await userEvent.click(screen.getByTestId("ai-apply-tags"));

    expect(screen.getByTestId("note-tag-suggestions-status")).toHaveTextContent(
      /Choose at least one tag/u,
    );
    expect(tagRequests.createTag).not.toHaveBeenCalled();
    expect(noteRequests.requestNoteDetail).not.toHaveBeenCalled();
    expect(noteRequests.updateNote).not.toHaveBeenCalled();
  });
});
