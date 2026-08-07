import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MENTION_EXTENSION_NAME,
  MENTION_PRIORITY,
  MENTION_REMOVED_CLASS,
} from "./extensions/Mention";
import { NoteBlockTab } from "./extensions/note-block-tab";
import { SLASH_COMMAND_PRIORITY } from "./extensions/slash-command";
import {
  MENTION_RESULT_LIMIT,
  createDebouncedSearch,
  createMentionDirectory,
  filterMentionCandidates,
  mentionCandidates,
  type MentionCandidate,
} from "./mention-members";
import { SLASH_COMMANDS, filterSlashCommands, normalizeSlashQuery } from "./slash-commands";
import {
  SUGGESTION_POPUP_MAX_HEIGHT,
  SUGGESTION_POPUP_MARGIN,
  SUGGESTION_POPUP_MIN_HEIGHT,
  SUGGESTION_POPUP_WIDTH,
  emptySuggestionPopupState,
  suggestionAnnouncement,
  suggestionPopupGeometry,
  wrapActiveIndex,
} from "./suggestion-popup";
import { EDITOR_TOOLBAR_GROUPS } from "./toolbar-commands";

import type { WorkspaceMemberPage } from "@notted/shared-types";

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

describe("slash command table", () => {
  it("declares unique ids, labels, and keywords", () => {
    const ids = SLASH_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = SLASH_COMMANDS.map((command) => command.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const command of SLASH_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.keywords.length).toBeGreaterThan(0);
    }
  });

  it("offers exactly the brief's commands that the contract can represent", () => {
    // Every entry here can be represented by the shared document contract, and
    // each was added only *after* that contract could represent it: `pageBreak`
    // in Part 38, `image` in Part 42, and `attachment` in Part 44, each of which
    // widened `NOTE_DOCUMENT_NODE_TYPES` first. The ordering of those two steps
    // is the rule this list encodes — a menu entry that produces a node the API
    // would refuse to store is a command that breaks saving the moment it is
    // used.
    //
    // `/image` and `/attachment` are also the two entries that insert nothing by
    // themselves: each opens the host's file picker, and a node appears only
    // once real bytes have a permanent attachment id.
    expect(SLASH_COMMANDS.map((command) => command.id)).toEqual([
      "heading1",
      "heading2",
      "heading3",
      "paragraph",
      "bulletList",
      "orderedList",
      "taskList",
      "table",
      "blockquote",
      "codeBlock",
      "divider",
      "pageBreak",
      "image",
      "attachment",
    ]);
  });

  it("folds spacing and punctuation out of both sides of a match", () => {
    expect(normalizeSlashQuery("Bullet-List")).toBe("bulletlist");
    expect(normalizeSlashQuery("  Heading 1 ")).toBe("heading1");
    for (const query of ["bullet list", "bullet-list", "BulletList"]) {
      expect(filterSlashCommands(query).map((command) => command.id)).toEqual(["bulletList"]);
    }
  });

  it("returns everything for an empty query and nothing for a miss", () => {
    expect(filterSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands("zzz")).toHaveLength(0);
  });

  it("keeps the suggestion plugins ahead of the Tab keymap", () => {
    // `NoteBlockTab` owns Tab at priority 200, so both popups must outrank it
    // to claim Tab while open — and only while open.
    const blockTab = NoteBlockTab.config.priority ?? 100;
    expect(SLASH_COMMAND_PRIORITY).toBeGreaterThan(blockTab);
    expect(MENTION_PRIORITY).toBeGreaterThan(blockTab);
  });

  it("exposes both suggestion triggers through the toolbar", () => {
    const insertGroup = EDITOR_TOOLBAR_GROUPS.find((group) => group.id === "insert");
    const ids = insertGroup?.items.map((item) => item.id) ?? [];
    expect(ids).toContain("insertBlockMenu");
    expect(ids).toContain("mentionMember");
  });
});

describe("suggestion popup state helpers", () => {
  it("starts closed with nothing active", () => {
    expect(emptySuggestionPopupState()).toEqual({
      open: false,
      query: "",
      items: [],
      activeIndex: -1,
      status: "ready",
      rect: null,
    });
  });

  it("wraps the active index in both directions", () => {
    expect(wrapActiveIndex(0, 3, 1)).toBe(1);
    expect(wrapActiveIndex(2, 3, 1)).toBe(0);
    expect(wrapActiveIndex(0, 3, -1)).toBe(2);
    // From "nothing active", down selects the first and up selects the last.
    expect(wrapActiveIndex(-1, 3, 1)).toBe(0);
    expect(wrapActiveIndex(-1, 3, -1)).toBe(2);
    expect(wrapActiveIndex(0, 0, 1)).toBe(-1);
  });

  it("announces counts, emptiness, loading, and failure", () => {
    const nouns = { singular: "member", plural: "members" };
    const base = { open: true, status: "ready" as const, items: [ADA], query: "ad" };
    expect(suggestionAnnouncement({ ...base, open: false }, nouns)).toBe("");
    expect(suggestionAnnouncement({ ...base, status: "loading" }, nouns)).toBe(
      "Searching members…",
    );
    expect(suggestionAnnouncement({ ...base, status: "error" }, nouns)).toBe(
      "members could not be loaded.",
    );
    expect(suggestionAnnouncement(base, nouns)).toContain("1 member available.");
    expect(suggestionAnnouncement({ ...base, items: [ADA, GRACE] }, nouns)).toContain(
      "2 members available.",
    );
    expect(suggestionAnnouncement({ ...base, items: [] }, nouns)).toBe("No members match ad.");
    expect(suggestionAnnouncement({ ...base, items: [], query: "" }, nouns)).toBe(
      "No members available.",
    );
  });
});

describe("suggestion popup geometry", () => {
  const viewport = { width: 1_000, height: 800 };

  it("sits under the caret when there is room", () => {
    const geometry = suggestionPopupGeometry({ top: 100, bottom: 120, left: 200 }, viewport);
    expect(geometry.placement).toBe("below");
    expect(geometry.top).toBeGreaterThan(120);
    expect(geometry.left).toBe(200);
    expect(geometry.maxHeight).toBeLessThanOrEqual(SUGGESTION_POPUP_MAX_HEIGHT);
  });

  it("flips above the caret when the space below is too small", () => {
    const geometry = suggestionPopupGeometry({ top: 760, bottom: 780, left: 200 }, viewport);
    expect(geometry.placement).toBe("above");
    expect(geometry.top).toBeLessThan(760);
    expect(geometry.top).toBeGreaterThanOrEqual(SUGGESTION_POPUP_MARGIN);
  });

  it("stays below when neither side has room, choosing the larger gap", () => {
    const geometry = suggestionPopupGeometry(
      { top: 10, bottom: 20, left: 0 },
      { ...viewport, height: 80 },
    );
    expect(geometry.placement).toBe("below");
    expect(geometry.maxHeight).toBe(SUGGESTION_POPUP_MIN_HEIGHT);
  });

  it("clamps horizontally inside the viewport", () => {
    const right = suggestionPopupGeometry({ top: 10, bottom: 20, left: 990 }, viewport);
    expect(right.left).toBe(viewport.width - SUGGESTION_POPUP_WIDTH - SUGGESTION_POPUP_MARGIN);

    const left = suggestionPopupGeometry({ top: 10, bottom: 20, left: -50 }, viewport);
    expect(left.left).toBe(SUGGESTION_POPUP_MARGIN);

    const narrow = suggestionPopupGeometry(
      { top: 10, bottom: 20, left: 100 },
      { width: 200, height: 800 },
    );
    expect(narrow.left).toBe(SUGGESTION_POPUP_MARGIN);
  });
});

describe("mention directory", () => {
  it("distinguishes current, former, and unknown members", () => {
    const directory = createMentionDirectory(null);
    // An unavailable list is never evidence that someone was removed.
    expect(directory.resolve(ADA.userId)).toEqual({ kind: "unknown" });

    directory.setMembers([ADA]);
    expect(directory.resolve(ADA.userId)).toEqual({ kind: "current", name: ADA.name });
    expect(directory.resolve(GRACE.userId)).toEqual({ kind: "former" });

    directory.setMembers(null);
    expect(directory.resolve(GRACE.userId)).toEqual({ kind: "unknown" });
  });

  it("notifies subscribers until they unsubscribe", () => {
    const directory = createMentionDirectory();
    const listener = vi.fn();
    const unsubscribe = directory.subscribe(listener);
    directory.setMembers([ADA]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    directory.setMembers([GRACE]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("names the removed state used by the node view and the stylesheet", () => {
    expect(MENTION_EXTENSION_NAME).toBe("mention");
    expect(MENTION_REMOVED_CLASS).toBe("notted-mention--removed");
  });
});

describe("mention candidates", () => {
  const page: WorkspaceMemberPage = {
    items: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        userId: ADA.userId,
        name: ADA.name,
        email: ADA.email,
        role: "admin",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    page: 1,
    limit: 100,
    hasMore: false,
  };

  it("projects a member page onto stable user ids", () => {
    expect(mentionCandidates(page)).toEqual([ADA]);
  });

  it("matches on name and email, and bounds the result count", () => {
    expect(filterMentionCandidates("ada", [ADA, GRACE])).toEqual([ADA]);
    expect(filterMentionCandidates("GRACE@EXAMPLE", [ADA, GRACE])).toEqual([GRACE]);
    expect(filterMentionCandidates("", [ADA, GRACE])).toEqual([ADA, GRACE]);
    expect(filterMentionCandidates("nobody", [ADA, GRACE])).toEqual([]);

    const many = Array.from({ length: MENTION_RESULT_LIMIT + 5 }, (_value, index) => ({
      ...ADA,
      userId: `0000000${index}-0000-4000-8000-000000000000`,
    }));
    expect(filterMentionCandidates("ada", many)).toHaveLength(MENTION_RESULT_LIMIT);
  });
});

describe("debounced mention search", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("issues one lookup for a burst of keystrokes", async () => {
    const search = vi.fn((): Promise<readonly MentionCandidate[]> => Promise.resolve([ADA]));
    const debounced = createDebouncedSearch(search, 100);

    const first = debounced("a");
    const second = debounced("ad");
    const third = debounced("ada");
    await vi.advanceTimersByTimeAsync(150);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("ada");
    // Superseded callers resolve empty rather than hanging.
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    await expect(third).resolves.toEqual([ADA]);
  });

  it("propagates a failure so the popup can show an error", async () => {
    const search = vi.fn((): Promise<readonly MentionCandidate[]> =>
      Promise.reject(new Error("unavailable")),
    );
    const debounced = createDebouncedSearch(search, 100);
    // The rejection handler is attached before the timer fires, so the failure
    // is observed rather than surfacing as an unhandled rejection.
    const settled = expect(debounced("ada")).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(150);
    await settled;
  });

  it("cancels a pending lookup without leaving it unresolved", async () => {
    const search = vi.fn((): Promise<readonly MentionCandidate[]> => Promise.resolve([ADA]));
    const debounced = createDebouncedSearch(search, 100);
    const pending = debounced("ada");
    debounced.cancel();
    await vi.advanceTimersByTimeAsync(150);

    expect(search).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual([]);
  });
});
