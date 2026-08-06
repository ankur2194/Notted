/**
 * Single source of truth for every keyboard binding the note editor exposes.
 *
 * The help dialog renders this list, the Notted keymap extension registers the
 * `source: "notted"` entries, and the editor registers the `scope: "global"`
 * entries. Nothing may advertise a binding that is not declared here, so the
 * documented shortcuts can never drift from the ones that actually run.
 *
 * Parts 35 and 36 extend the editor by appending entries to
 * `EDITOR_SHORTCUTS` (and, when a binding is not a TipTap default, wiring a
 * matching `handler` in `extensions/editor-shortcuts.ts`).
 */

export type EditorShortcutScope = "editor" | "global";

/** `tiptap` bindings ship with the configured extensions; `notted` bindings are ours. */
export type EditorShortcutSource = "tiptap" | "notted";

export type EditorShortcutGroupId =
  "text" | "blocks" | "lists" | "alignment" | "history" | "view" | "help";

/** Handlers the host component supplies for bindings that drive React UI. */
export type EditorShortcutHandlerId =
  | "insertLink"
  | "openShortcutsHelp"
  | "openSlashMenu"
  | "insertMention"
  | "insertPageBreak"
  | "toggleFocusMode";

export interface EditorShortcutGroup {
  readonly id: EditorShortcutGroupId;
  readonly label: string;
}

export interface EditorShortcut {
  readonly id: string;
  readonly group: EditorShortcutGroupId;
  readonly description: string;
  /** ProseMirror keymap syntax (`Mod-Shift-s`), or a bare key for global bindings. */
  readonly binding: string;
  /** `editor` bindings run inside the ProseMirror keymap; `global` ones listen on the document. */
  readonly scope: EditorShortcutScope;
  readonly source: EditorShortcutSource;
  /**
   * Set only when the binding calls back into React instead of an editor
   * command. A `notted` binding with a `null` handler is registered by a
   * Notted TipTap extension that reads its binding from this table (see
   * `extensions/note-block-tab.ts`).
   */
  readonly handler: EditorShortcutHandlerId | null;
}

export const EDITOR_SHORTCUT_GROUPS: readonly EditorShortcutGroup[] = Object.freeze([
  { id: "text", label: "Text formatting" },
  { id: "blocks", label: "Paragraphs and blocks" },
  { id: "lists", label: "Lists" },
  { id: "alignment", label: "Alignment" },
  { id: "history", label: "History" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
]);

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

const HEADING_SHORTCUTS: readonly EditorShortcut[] = HEADING_LEVELS.map((level) => ({
  id: `heading${level}`,
  group: "blocks" as const,
  description: `Heading ${level}`,
  binding: `Mod-Alt-${level}`,
  scope: "editor" as const,
  source: "tiptap" as const,
  handler: null,
}));

export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = Object.freeze([
  {
    id: "bold",
    group: "text",
    description: "Bold",
    binding: "Mod-b",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "italic",
    group: "text",
    description: "Italic",
    binding: "Mod-i",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "underline",
    group: "text",
    description: "Underline",
    binding: "Mod-u",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "strike",
    group: "text",
    description: "Strikethrough",
    binding: "Mod-Shift-s",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "code",
    group: "text",
    description: "Inline code",
    binding: "Mod-e",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "subscript",
    group: "text",
    description: "Subscript",
    binding: "Mod-,",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "superscript",
    group: "text",
    description: "Superscript",
    binding: "Mod-.",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "link",
    group: "text",
    description: "Insert or edit a link",
    binding: "Mod-k",
    scope: "editor",
    source: "notted",
    handler: "insertLink",
  },
  {
    id: "mentionMember",
    group: "text",
    description: "Mention a workspace member",
    binding: "Mod-Alt-m",
    scope: "editor",
    source: "notted",
    handler: "insertMention",
  },
  {
    id: "paragraph",
    group: "blocks",
    description: "Paragraph",
    binding: "Mod-Alt-0",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  ...HEADING_SHORTCUTS,
  {
    id: "blockquote",
    group: "blocks",
    description: "Blockquote",
    binding: "Mod-Shift-b",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "codeBlock",
    group: "blocks",
    description: "Code block",
    binding: "Mod-Alt-c",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "insertBlockMenu",
    group: "blocks",
    description: "Open the slash command menu",
    binding: "Mod-Alt-i",
    scope: "editor",
    source: "notted",
    handler: "openSlashMenu",
  },
  {
    id: "hardBreak",
    group: "blocks",
    description: "Line break inside a block",
    binding: "Shift-Enter",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    // Free binding: StarterKit only claims `Enter`, `Mod-Enter`, and
    // `Shift-Enter` around Enter, and no configured extension binds
    // `Mod-Shift-Enter`. `Shift-Enter` cannot swallow it either, because
    // ProseMirror matches the whole modifier set, not a subset.
    id: "pageBreak",
    group: "blocks",
    description: "Insert a page break",
    binding: "Mod-Shift-Enter",
    scope: "editor",
    source: "notted",
    handler: "insertPageBreak",
  },
  {
    id: "bulletList",
    group: "lists",
    description: "Bulleted list",
    binding: "Mod-Shift-8",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "orderedList",
    group: "lists",
    description: "Numbered list",
    binding: "Mod-Shift-7",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "taskList",
    group: "lists",
    description: "Task list",
    binding: "Mod-Shift-9",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "indentBlock",
    group: "lists",
    description: "Indent list item, or move to the next table cell",
    binding: "Tab",
    scope: "editor",
    source: "notted",
    handler: null,
  },
  {
    id: "outdentBlock",
    group: "lists",
    description: "Outdent list item, or move to the previous table cell",
    binding: "Shift-Tab",
    scope: "editor",
    source: "notted",
    handler: null,
  },
  {
    id: "alignLeft",
    group: "alignment",
    description: "Align left",
    binding: "Mod-Shift-l",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "alignCenter",
    group: "alignment",
    description: "Align center",
    binding: "Mod-Shift-e",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "alignRight",
    group: "alignment",
    description: "Align right",
    binding: "Mod-Shift-r",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "alignJustify",
    group: "alignment",
    description: "Justify",
    binding: "Mod-Shift-j",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "undo",
    group: "history",
    description: "Undo",
    binding: "Mod-z",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "redo",
    group: "history",
    description: "Redo",
    binding: "Mod-Shift-z",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    id: "redoAlternate",
    group: "history",
    description: "Redo (alternate)",
    binding: "Mod-y",
    scope: "editor",
    source: "tiptap",
    handler: null,
  },
  {
    // `Mod-Shift-f` is unclaimed: the only `Mod-Shift-<letter>` bindings in this
    // table are s, b, l, e, r, j, and z, and Highlight's `Mod-Shift-h` is the
    // only other one any configured extension registers.
    id: "focusMode",
    group: "view",
    description: "Toggle focus mode",
    binding: "Mod-Shift-f",
    scope: "editor",
    source: "notted",
    handler: "toggleFocusMode",
  },
  {
    id: "shortcutsHelp",
    group: "help",
    description: "Show keyboard shortcuts",
    binding: "Mod-/",
    scope: "global",
    source: "notted",
    handler: "openShortcutsHelp",
  },
  {
    id: "shortcutsHelpAlternate",
    group: "help",
    description: "Show keyboard shortcuts (outside text fields)",
    binding: "?",
    scope: "global",
    source: "notted",
    handler: "openShortcutsHelp",
  },
]);

const SHORTCUTS_BY_ID: ReadonlyMap<string, EditorShortcut> = new Map(
  EDITOR_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]),
);

export function editorShortcutById(id: string): EditorShortcut | undefined {
  return SHORTCUTS_BY_ID.get(id);
}

/**
 * Binding string for a declared shortcut. Notted extensions register their
 * keymaps through this so a live binding can never drift from the one the help
 * dialog advertises. Throws for an unknown id, which is a wiring bug rather
 * than a runtime condition.
 */
export function editorShortcutBinding(id: string): string {
  const shortcut = SHORTCUTS_BY_ID.get(id);
  if (shortcut === undefined) throw new Error(`Unknown editor shortcut: ${id}`);
  return shortcut.binding;
}

export function editorShortcutsForGroup(group: EditorShortcutGroupId): readonly EditorShortcut[] {
  return EDITOR_SHORTCUTS.filter((shortcut) => shortcut.group === group);
}

/** Bindings the Notted keymap extension must register on the ProseMirror keymap. */
export function editorScopedNottedShortcuts(): readonly EditorShortcut[] {
  return EDITOR_SHORTCUTS.filter(
    (shortcut) =>
      shortcut.scope === "editor" && shortcut.source === "notted" && shortcut.handler !== null,
  );
}

/** Bindings the host component must listen for on the document. */
export function globalShortcuts(): readonly EditorShortcut[] {
  return EDITOR_SHORTCUTS.filter((shortcut) => shortcut.scope === "global");
}

interface PlatformCandidate {
  readonly platform?: unknown;
  readonly userAgent?: unknown;
}

/**
 * Detect Apple platforms without assuming `navigator` exists or has any
 * particular shape. Only affects how a binding is *rendered*: the bindings
 * themselves are normalized by ProseMirror.
 */
export function isApplePlatform(candidate?: unknown): boolean {
  const source: unknown =
    candidate ?? (typeof globalThis.navigator === "undefined" ? null : globalThis.navigator);
  if (typeof source !== "object" || source === null) return false;
  const record = source as PlatformCandidate;
  const platform = typeof record.platform === "string" ? record.platform : "";
  const userAgent = typeof record.userAgent === "string" ? record.userAgent : "";
  return /mac|iphone|ipad|ipod/i.test(`${platform} ${userAgent}`);
}

const APPLE_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Cmd: "⌘",
  Meta: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Ctrl: "⌃",
  Control: "⌃",
  Enter: "↩",
};

const OTHER_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Mod: "Ctrl",
  Cmd: "Ctrl",
  Meta: "Ctrl",
  Shift: "Shift",
  Alt: "Alt",
  Ctrl: "Ctrl",
  Control: "Ctrl",
  Enter: "Enter",
};

const APPLE_KEY_NAMES: Readonly<Record<string, string>> = {
  Mod: "Command",
  Cmd: "Command",
  Meta: "Command",
  Shift: "Shift",
  Alt: "Option",
  Ctrl: "Control",
  Control: "Control",
  Enter: "Enter",
};

const OTHER_KEY_NAMES: Readonly<Record<string, string>> = {
  Mod: "Control",
  Cmd: "Control",
  Meta: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Ctrl: "Control",
  Control: "Control",
  Enter: "Enter",
};

/** Split a binding exactly the way ProseMirror's keymap does. */
export function splitShortcutBinding(binding: string): readonly string[] {
  return binding.split(/-(?!$)/);
}

function displayToken(token: string, apple: boolean): string {
  const table = apple ? APPLE_KEY_SYMBOLS : OTHER_KEY_SYMBOLS;
  const mapped = table[token];
  if (mapped !== undefined) return mapped;
  return token.length === 1 ? token.toUpperCase() : token;
}

function spokenToken(token: string, apple: boolean): string {
  const table = apple ? APPLE_KEY_NAMES : OTHER_KEY_NAMES;
  const mapped = table[token];
  if (mapped !== undefined) return mapped;
  return token.length === 1 ? token.toUpperCase() : token;
}

export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** True when a binding has no modifier tokens (so it must not fire while typing). */
export function isBareKeyBinding(binding: string): boolean {
  return splitShortcutBinding(binding).length === 1;
}

/**
 * Match a document-level key event against a binding. `Mod` resolves to the
 * platform's primary modifier. Bare-key bindings ignore Shift because the key
 * itself (for example `?`) may require it.
 */
export function matchesShortcutBinding(
  binding: string,
  event: ShortcutKeyEvent,
  apple: boolean,
): boolean {
  const tokens = splitShortcutBinding(binding);
  const key = tokens[tokens.length - 1];
  if (key === undefined) return false;
  const modifiers = new Set(tokens.slice(0, -1));
  const hasMod = modifiers.has("Mod");
  const wantMeta = modifiers.has("Cmd") || modifiers.has("Meta") || (apple && hasMod);
  const wantCtrl = modifiers.has("Ctrl") || modifiers.has("Control") || (!apple && hasMod);
  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== modifiers.has("Alt")) return false;
  if (modifiers.size > 0 && event.shiftKey !== modifiers.has("Shift")) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}

/** Visible key caps for a binding, in press order. */
export function formatShortcutKeys(binding: string, apple: boolean): readonly string[] {
  return splitShortcutBinding(binding).map((token) => displayToken(token, apple));
}

/** Screen-reader friendly rendition of the same binding. */
export function describeShortcutKeys(binding: string, apple: boolean): string {
  return splitShortcutBinding(binding)
    .map((token) => spokenToken(token, apple))
    .join(" plus ");
}
