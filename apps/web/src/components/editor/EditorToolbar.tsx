"use client";

import { Baseline, Highlighter, Keyboard, Link2, Table2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { ColorPickerDialog } from "./ColorPickerDialog";
import { NOTE_HIGHLIGHT_COLORS, NOTE_TEXT_COLORS } from "./editor-colors";
import { CODE_BLOCK_LANGUAGE_OPTIONS } from "./extensions/code-block-languages";
import { NOTE_FONT_SIZES, isAllowedNoteFontSize } from "./extensions/font-size";
import { editorShortcutById, formatShortcutKeys, isApplePlatform } from "./keyboard-shortcuts";
import { LinkDialog } from "./LinkDialog";
import { TableMenuDialog } from "./TableMenuDialog";
import {
  BLOCK_TYPE_OPTIONS,
  EDITOR_TOOLBAR_GROUPS,
  activeBlockType,
  activeCodeLanguage,
  activeFontSize,
  activeHighlightColor,
  activeLinkHref,
  activeTextColor,
  applyBlockType,
  applyCodeLanguage,
  applyFontSize,
  applyHighlight,
  applyLink,
  applyTextColor,
  isBlockTypeValue,
  removeLink,
  toolbarItemIds,
  type ToolbarButtonCommand,
  type ToolbarControlCommand,
  type ToolbarGroup,
} from "./toolbar-commands";
import { useRovingToolbar } from "./useRovingToolbar";

import type { Editor } from "@tiptap/core";

const CONTROL_CLASSES =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-transparent bg-transparent px-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none aria-pressed:border-input aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-disabled:opacity-50";

const SELECT_CLASSES =
  "min-h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground";

export interface EditorToolbarProps {
  readonly editor: Editor | null;
  readonly editable: boolean;
  readonly onOpenShortcuts: () => void;
  readonly linkDialogOpen: boolean;
  readonly onLinkDialogOpenChange: (open: boolean) => void;
  /** Defaults to the shared group table; overridable for tests and future parts. */
  readonly groups?: readonly ToolbarGroup[];
}

function accessibleNameFor(label: string, shortcutId: string | undefined, apple: boolean): string {
  if (shortcutId === undefined) return label;
  const shortcut = editorShortcutById(shortcutId);
  if (shortcut === undefined) return label;
  return `${label} (${formatShortcutKeys(shortcut.binding, apple).join(" + ")})`;
}

/**
 * Formatting toolbar for `TiptapEditor`.
 *
 * Contents come from `toolbar-commands.ts`, so Parts 35 and 36 extend the
 * toolbar by editing that table rather than this component. The toolbar is a
 * single tab stop with roving arrow-key navigation, wraps instead of clipping
 * on narrow screens, and reflects the editor's active formatting through
 * `aria-pressed`.
 *
 * When the note is not editable only the help group is rendered; the formatting
 * controls are absent rather than present-but-inert.
 */
export function EditorToolbar({
  editor,
  editable,
  onOpenShortcuts,
  linkDialogOpen,
  onLinkDialogOpenChange,
  groups = EDITOR_TOOLBAR_GROUPS,
}: EditorToolbarProps) {
  const apple = useMemo(() => isApplePlatform(), []);
  const visibleGroups = useMemo(
    () => (editable ? groups : groups.filter((group) => group.id === "help")),
    [editable, groups],
  );
  const itemIds = useMemo(() => toolbarItemIds(visibleGroups), [visibleGroups]);
  const { toolbarRef, tabIndexFor, onItemFocus, onKeyDown } = useRovingToolbar(itemIds);
  const instructionsId = useId();
  const [openColorControl, setOpenColorControl] = useState<"textColor" | "highlightColor" | null>(
    null,
  );
  const [tableMenuOpen, setTableMenuOpen] = useState(false);

  function renderButton(item: ToolbarButtonCommand) {
    const name = accessibleNameFor(item.label, item.shortcutId, apple);
    const active = editor !== null && item.isActive !== undefined && item.isActive(editor);
    const unavailable =
      editor === null || (item.isAvailable !== undefined && !item.isAvailable(editor));
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        data-toolbar-item={item.id}
        tabIndex={tabIndexFor(item.id)}
        onFocus={() => onItemFocus(item.id)}
        aria-label={name}
        title={name}
        aria-pressed={item.isActive === undefined ? undefined : active}
        aria-disabled={unavailable ? true : undefined}
        onClick={() => {
          if (editor === null || unavailable) return;
          item.run(editor);
        }}
        className={CONTROL_CLASSES}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    );
  }

  function renderBlockType(item: ToolbarControlCommand) {
    return (
      <select
        key={item.id}
        data-toolbar-item={item.id}
        tabIndex={tabIndexFor(item.id)}
        onFocus={() => onItemFocus(item.id)}
        aria-label={item.label}
        title={item.label}
        className={SELECT_CLASSES}
        value={editor === null ? "paragraph" : activeBlockType(editor)}
        onChange={(event) => {
          if (editor === null) return;
          const next = event.target.value;
          if (!isBlockTypeValue(next)) return;
          applyBlockType(editor, next);
        }}
      >
        {BLOCK_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  function renderFontSize(item: ToolbarControlCommand) {
    return (
      <select
        key={item.id}
        data-toolbar-item={item.id}
        tabIndex={tabIndexFor(item.id)}
        onFocus={() => onItemFocus(item.id)}
        aria-label={item.label}
        title={item.label}
        className={SELECT_CLASSES}
        value={editor === null ? "" : (activeFontSize(editor) ?? "")}
        onChange={(event) => {
          if (editor === null) return;
          const next = event.target.value;
          applyFontSize(editor, isAllowedNoteFontSize(next) ? next : null);
        }}
      >
        <option value="">Default size</option>
        {NOTE_FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    );
  }

  function renderColorControl(
    item: ToolbarControlCommand,
    control: "textColor" | "highlightColor",
  ) {
    const isText = control === "textColor";
    const value =
      editor === null ? null : isText ? activeTextColor(editor) : activeHighlightColor(editor);
    const Icon = isText ? Baseline : Highlighter;
    const name = accessibleNameFor(item.label, item.shortcutId, apple);
    return (
      <span key={item.id} className="inline-flex">
        <button
          type="button"
          data-toolbar-item={item.id}
          tabIndex={tabIndexFor(item.id)}
          onFocus={() => onItemFocus(item.id)}
          aria-label={name}
          title={name}
          aria-haspopup="dialog"
          aria-pressed={value !== null}
          onClick={() => setOpenColorControl(control)}
          className={CONTROL_CLASSES}
        >
          <Icon aria-hidden="true" className="size-4" />
          <span
            aria-hidden="true"
            data-testid={`${item.id}-swatch`}
            className="h-1 w-4 rounded-sm border border-black/10"
            style={{ backgroundColor: value ?? "transparent" }}
          />
        </button>
        <ColorPickerDialog
          open={openColorControl === control}
          onOpenChange={(next) => setOpenColorControl(next ? control : null)}
          title={item.label}
          description={
            isText
              ? "Choose a text colour from the note palette."
              : "Choose a highlight colour from the note palette."
          }
          options={isText ? NOTE_TEXT_COLORS : NOTE_HIGHLIGHT_COLORS}
          value={value}
          clearLabel={isText ? "Remove text colour" : "Remove highlight"}
          onSelect={(color) => {
            if (editor === null) return;
            if (isText) applyTextColor(editor, color);
            else applyHighlight(editor, color);
          }}
          onClear={() => {
            if (editor === null) return;
            if (isText) applyTextColor(editor, null);
            else applyHighlight(editor, null);
          }}
        />
      </span>
    );
  }

  function renderLinkControl(item: ToolbarControlCommand) {
    const currentHref = editor === null ? "" : activeLinkHref(editor);
    const hasLink = editor !== null && editor.isActive("link");
    const name = accessibleNameFor(hasLink ? "Edit link" : item.label, item.shortcutId, apple);
    return (
      <span key={item.id} className="inline-flex">
        <button
          type="button"
          data-toolbar-item={item.id}
          tabIndex={tabIndexFor(item.id)}
          onFocus={() => onItemFocus(item.id)}
          aria-label={name}
          title={name}
          aria-haspopup="dialog"
          aria-pressed={hasLink}
          onClick={() => onLinkDialogOpenChange(true)}
          className={CONTROL_CLASSES}
        >
          <Link2 aria-hidden="true" className="size-4" />
        </button>
        <LinkDialog
          open={linkDialogOpen}
          onOpenChange={onLinkDialogOpenChange}
          initialHref={currentHref}
          hasLink={hasLink}
          onApply={(href) => (editor === null ? false : applyLink(editor, href))}
          onRemove={() => {
            if (editor !== null) removeLink(editor);
          }}
        />
      </span>
    );
  }

  function renderCodeLanguageControl(item: ToolbarControlCommand) {
    const inCodeBlock = editor !== null && editor.isActive("codeBlock");
    return (
      <select
        key={item.id}
        data-toolbar-item={item.id}
        tabIndex={tabIndexFor(item.id)}
        onFocus={() => onItemFocus(item.id)}
        aria-label={item.label}
        title={item.label}
        // Kept mounted and focusable outside a code block so the roving tab
        // index never has to reshuffle; it simply has nothing to change.
        aria-disabled={inCodeBlock ? undefined : true}
        className={SELECT_CLASSES}
        value={editor === null ? "" : (activeCodeLanguage(editor) ?? "")}
        onChange={(event) => {
          if (editor === null || !inCodeBlock) return;
          const next = event.target.value;
          applyCodeLanguage(editor, next === "" ? null : next);
        }}
      >
        <option value="">Plain text</option>
        {CODE_BLOCK_LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  function renderTableControl(item: ToolbarControlCommand) {
    const name = accessibleNameFor(item.label, item.shortcutId, apple);
    return (
      <span key={item.id} className="inline-flex">
        <button
          type="button"
          data-toolbar-item={item.id}
          tabIndex={tabIndexFor(item.id)}
          onFocus={() => onItemFocus(item.id)}
          aria-label={name}
          title={name}
          aria-haspopup="dialog"
          aria-pressed={editor !== null && editor.isActive("table")}
          onClick={() => setTableMenuOpen(true)}
          className={CONTROL_CLASSES}
        >
          <Table2 aria-hidden="true" className="size-4" />
        </button>
        <TableMenuDialog open={tableMenuOpen} onOpenChange={setTableMenuOpen} editor={editor} />
      </span>
    );
  }

  function renderShortcutsControl(item: ToolbarControlCommand) {
    const name = accessibleNameFor(item.label, item.shortcutId, apple);
    return (
      <button
        key={item.id}
        type="button"
        data-toolbar-item={item.id}
        tabIndex={tabIndexFor(item.id)}
        onFocus={() => onItemFocus(item.id)}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        onClick={onOpenShortcuts}
        className={CONTROL_CLASSES}
      >
        <Keyboard aria-hidden="true" className="size-4" />
      </button>
    );
  }

  function renderControl(item: ToolbarControlCommand) {
    switch (item.control) {
      case "blockType":
        return renderBlockType(item);
      case "fontSize":
        return renderFontSize(item);
      case "textColor":
        return renderColorControl(item, "textColor");
      case "highlightColor":
        return renderColorControl(item, "highlightColor");
      case "link":
        return renderLinkControl(item);
      case "codeLanguage":
        return renderCodeLanguageControl(item);
      case "table":
        return renderTableControl(item);
      case "shortcuts":
        return renderShortcutsControl(item);
      default:
        return null;
    }
  }

  return (
    <>
      <p id={instructionsId} className="sr-only">
        Use the left and right arrow keys to move between toolbar controls, and Home or End to jump
        to the first or last control. Use the up and down arrow keys to change a menu value.
      </p>
      <div
        ref={toolbarRef}
        role="toolbar"
        onKeyDown={onKeyDown}
        aria-orientation="horizontal"
        aria-label={editable ? "Note formatting" : "Note editor actions (read only)"}
        aria-describedby={instructionsId}
        className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1"
      >
        {visibleGroups.map((group) => (
          <div
            key={group.id}
            role="group"
            aria-label={group.label}
            className="flex flex-wrap items-center gap-1"
          >
            {group.items.map((item) =>
              item.kind === "button" ? renderButton(item) : renderControl(item),
            )}
          </div>
        ))}
      </div>
    </>
  );
}
