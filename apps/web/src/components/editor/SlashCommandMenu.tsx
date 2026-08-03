"use client";

import { suggestionAnnouncement } from "./suggestion-popup";
import { SuggestionPopover } from "./SuggestionPopover";

import type { SlashCommand } from "./slash-commands";
import type { SuggestionPopupState } from "./suggestion-popup";
import type { Editor } from "@tiptap/core";

export const SLASH_MENU_LISTBOX_ID = "notted-slash-command-menu";
export const SLASH_MENU_LABEL = "Block commands";

export interface SlashCommandMenuProps {
  readonly editor: Editor | null;
  readonly state: SuggestionPopupState<SlashCommand>;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly onDismiss: () => void;
}

/**
 * The `/` menu.
 *
 * Contents come from `slash-commands.ts`, and positioning, focus, keyboard
 * routing, click-away, and the ARIA wiring all come from `SuggestionPopover`,
 * so Parts 38 and 42 add `/page-break` and `/image` by appending one entry to
 * `SLASH_COMMANDS` and changing nothing here.
 */
export function SlashCommandMenu({
  editor,
  state,
  onSelect,
  onActivate,
  onDismiss,
}: SlashCommandMenuProps) {
  return (
    <SuggestionPopover<SlashCommand>
      editor={editor}
      state={state}
      listboxId={SLASH_MENU_LISTBOX_ID}
      label={SLASH_MENU_LABEL}
      announcement={suggestionAnnouncement(state, { singular: "command", plural: "commands" })}
      loadingMessage="Loading commands…"
      emptyMessage="No commands match. Press Escape to keep typing."
      errorMessage="Commands are unavailable. Press Escape to keep typing."
      itemKey={(command) => command.id}
      renderItem={(command) => {
        const Icon = command.icon;
        return (
          <>
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate font-medium">{command.label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {command.description}
              </span>
            </span>
          </>
        );
      }}
      onSelect={onSelect}
      onActivate={onActivate}
      onDismiss={onDismiss}
    />
  );
}
