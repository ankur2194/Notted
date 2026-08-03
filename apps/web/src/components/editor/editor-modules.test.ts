import { describe, expect, it } from "vitest";

import { areDocumentsEquivalent, stableStringify } from "./document-sync";
import { NOTE_HIGHLIGHT_COLORS, NOTE_TEXT_COLORS, isAllowedEditorColor } from "./editor-colors";
import { NoteBlockTab } from "./extensions/note-block-tab";
import {
  EDITOR_SHORTCUTS,
  EDITOR_SHORTCUT_GROUPS,
  describeShortcutKeys,
  editorScopedNottedShortcuts,
  editorShortcutBinding,
  editorShortcutById,
  editorShortcutsForGroup,
  formatShortcutKeys,
  globalShortcuts,
  isApplePlatform,
  isBareKeyBinding,
  matchesShortcutBinding,
  splitShortcutBinding,
} from "./keyboard-shortcuts";
import {
  BLOCK_TYPE_OPTIONS,
  EDITOR_TOOLBAR_GROUPS,
  TABLE_ACTIONS,
  isBlockTypeValue,
  toolbarItemIds,
} from "./toolbar-commands";

function keyEvent(overrides: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}) {
  return {
    key: overrides.key,
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
  };
}

describe("keyboard shortcut contract", () => {
  it("declares unique ids and only known groups", () => {
    const ids = EDITOR_SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groupIds = new Set(EDITOR_SHORTCUT_GROUPS.map((group) => group.id));
    for (const shortcut of EDITOR_SHORTCUTS) {
      expect(groupIds.has(shortcut.group)).toBe(true);
      expect(shortcut.binding.length).toBeGreaterThan(0);
    }
  });

  it("never declares two shortcuts for the same editor-scoped binding", () => {
    const bindings = EDITOR_SHORTCUTS.filter((shortcut) => shortcut.scope === "editor").map(
      (shortcut) => shortcut.binding,
    );
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it("splits bindings the way ProseMirror does", () => {
    expect(splitShortcutBinding("Mod-Shift-s")).toEqual(["Mod", "Shift", "s"]);
    expect(splitShortcutBinding("Mod-,")).toEqual(["Mod", ","]);
    expect(splitShortcutBinding("?")).toEqual(["?"]);
  });

  it("classifies bare-key bindings", () => {
    expect(isBareKeyBinding("?")).toBe(true);
    expect(isBareKeyBinding("Mod-/")).toBe(false);
  });

  it("routes every notted-sourced editor binding through a handler", () => {
    const scoped = editorScopedNottedShortcuts();
    expect(scoped.length).toBeGreaterThan(0);
    for (const shortcut of scoped) {
      expect(shortcut.source).toBe("notted");
      expect(shortcut.scope).toBe("editor");
      expect(shortcut.handler).not.toBeNull();
    }
  });

  it("exposes the global bindings the host must listen for", () => {
    const ids = globalShortcuts().map((shortcut) => shortcut.id);
    expect(ids).toContain("shortcutsHelp");
    expect(ids).toContain("shortcutsHelpAlternate");
  });

  it("looks shortcuts up by id and by group", () => {
    expect(editorShortcutById("bold")?.binding).toBe("Mod-b");
    expect(editorShortcutById("nope")).toBeUndefined();
    expect(editorShortcutsForGroup("history").map((shortcut) => shortcut.id)).toEqual([
      "undo",
      "redo",
      "redoAlternate",
    ]);
  });

  it("renders platform-appropriate key caps and spoken names", () => {
    expect(formatShortcutKeys("Mod-Shift-s", false)).toEqual(["Ctrl", "Shift", "S"]);
    expect(formatShortcutKeys("Mod-Shift-s", true)).toEqual(["⌘", "⇧", "S"]);
    expect(formatShortcutKeys("Shift-Enter", false)).toEqual(["Shift", "Enter"]);
    expect(describeShortcutKeys("Mod-b", true)).toBe("Command plus B");
    expect(describeShortcutKeys("Mod-b", false)).toBe("Control plus B");
  });

  it("detects Apple platforms without assuming a navigator shape", () => {
    expect(isApplePlatform(null)).toBe(false);
    expect(isApplePlatform({})).toBe(false);
    expect(isApplePlatform({ platform: 42 })).toBe(false);
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" })).toBe(true);
    expect(isApplePlatform({ platform: "Win32", userAgent: "Windows NT 10.0" })).toBe(false);
    // jsdom's own navigator must not be mistaken for Apple hardware.
    expect(isApplePlatform()).toBe(false);
  });

  it("matches global bindings against key events per platform", () => {
    expect(matchesShortcutBinding("Mod-/", keyEvent({ key: "/", ctrlKey: true }), false)).toBe(
      true,
    );
    expect(matchesShortcutBinding("Mod-/", keyEvent({ key: "/", metaKey: true }), false)).toBe(
      false,
    );
    expect(matchesShortcutBinding("Mod-/", keyEvent({ key: "/", metaKey: true }), true)).toBe(true);
    expect(
      matchesShortcutBinding("Mod-/", keyEvent({ key: "/", ctrlKey: true, altKey: true }), false),
    ).toBe(false);
    // A bare key ignores Shift (it may be required to produce the character).
    expect(matchesShortcutBinding("?", keyEvent({ key: "?", shiftKey: true }), false)).toBe(true);
    expect(matchesShortcutBinding("?", keyEvent({ key: "?", ctrlKey: true }), false)).toBe(false);
    expect(matchesShortcutBinding("?", keyEvent({ key: "/" }), false)).toBe(false);
  });
});

describe("document sync comparison", () => {
  it("ignores object key order", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(
      areDocumentsEquivalent(
        { type: "doc", content: [{ attrs: { level: 1 }, type: "heading" }] },
        { type: "doc", content: [{ type: "heading", attrs: { level: 1 } }] },
      ),
    ).toBe(true);
  });

  it("respects array order and value differences", () => {
    expect(areDocumentsEquivalent([1, 2], [2, 1])).toBe(false);
    expect(areDocumentsEquivalent({ type: "doc" }, { type: "doc", content: [] })).toBe(false);
    expect(areDocumentsEquivalent(null, undefined)).toBe(false);
  });
});

describe("editor colour palette", () => {
  it("accepts only palette values that are valid #rrggbb", () => {
    for (const option of [...NOTE_TEXT_COLORS, ...NOTE_HIGHLIGHT_COLORS]) {
      expect(isAllowedEditorColor(option.value)).toBe(true);
      expect(option.value).toMatch(/^#[0-9a-f]{6}$/u);
    }
    expect(isAllowedEditorColor("#fff")).toBe(false);
    expect(isAllowedEditorColor("red")).toBe(false);
    expect(isAllowedEditorColor("#123456")).toBe(false);
    expect(isAllowedEditorColor(null)).toBe(false);
    expect(isAllowedEditorColor(42)).toBe(false);
  });
});

describe("toolbar command table", () => {
  it("uses unique control ids across every group", () => {
    const ids = toolbarItemIds(EDITOR_TOOLBAR_GROUPS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("bold");
    expect(ids).toContain("shortcuts");
  });

  it("references only declared shortcut ids", () => {
    for (const group of EDITOR_TOOLBAR_GROUPS) {
      for (const item of group.items) {
        if (item.shortcutId === undefined) continue;
        expect(editorShortcutById(item.shortcutId)).toBeDefined();
      }
    }
  });

  it("recognises exactly the declared block type values", () => {
    for (const option of BLOCK_TYPE_OPTIONS) expect(isBlockTypeValue(option.value)).toBe(true);
    expect(isBlockTypeValue("heading7")).toBe(false);
    expect(isBlockTypeValue("toString")).toBe(false);
  });
});

describe("block behaviour seams", () => {
  it("resolves declared bindings and rejects unknown ids", () => {
    expect(editorShortcutBinding("indentBlock")).toBe("Tab");
    expect(editorShortcutBinding("outdentBlock")).toBe("Shift-Tab");
    expect(() => editorShortcutBinding("nope")).toThrow(/Unknown editor shortcut/u);
  });

  it("gives the Tab keymap a higher priority than TipTap's own bindings", () => {
    expect(NoteBlockTab.name).toBe("nottedBlockTab");
    // TipTap's Table, TaskItem, and ListItem extensions all use the default 100,
    // so the single deliberate handler must sort ahead of them.
    expect(NoteBlockTab.config.priority ?? 100).toBeGreaterThan(100);
  });

  it("declares unique table actions with distinct labels", () => {
    const ids = TABLE_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = TABLE_ACTIONS.map((action) => action.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of ["insertTable", "mergeCells", "splitCell", "toggleHeaderRow", "deleteTable"]) {
      expect(ids).toContain(id);
    }
  });
});
