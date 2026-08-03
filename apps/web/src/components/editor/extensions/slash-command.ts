import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";

import {
  SLASH_COMMANDS,
  availableSlashCommands,
  filterSlashCommands,
  type SlashCommand,
} from "../slash-commands";
import { SLASH_COMMAND_TRIGGER, isSlashCommandPosition } from "../suggestion-triggers";

import { createSuggestionSource } from "./suggestion-bridge";

import type { SuggestionSink } from "../suggestion-popup";

export const SLASH_COMMAND_EXTENSION_NAME = "nottedSlashCommand";

/**
 * Above `NoteBlockTab` (200) so the open menu decides what Tab means before the
 * indent/outdent handler sees it. The suggestion plugin returns `false` for
 * every key while the menu is closed, so `runBlockTab` keeps Tab the rest of
 * the time and the editor never becomes a keyboard trap.
 */
export const SLASH_COMMAND_PRIORITY = 250;

export interface NoteSlashCommandConfig {
  /** Resolved per call so the popup's React state never rebuilds the editor. */
  readonly resolveSink?: () => SuggestionSink<SlashCommand> | null;
  readonly commands?: readonly SlashCommand[];
}

export function createNoteSlashCommand(config: NoteSlashCommandConfig = {}) {
  const resolveSink = config.resolveSink ?? ((): null => null);
  const commands = config.commands ?? SLASH_COMMANDS;
  const source = createSuggestionSource<SlashCommand>(resolveSink, (query, editor) =>
    filterSlashCommands(query, availableSlashCommands(editor, commands)),
  );

  return Extension.create({
    name: SLASH_COMMAND_EXTENSION_NAME,
    priority: SLASH_COMMAND_PRIORITY,

    addProseMirrorPlugins() {
      return [
        Suggestion<SlashCommand, SlashCommand>({
          editor: this.editor,
          char: SLASH_COMMAND_TRIGGER,
          startOfLine: true,
          pluginKey: new PluginKey(SLASH_COMMAND_EXTENSION_NAME),
          decorationClass: "notted-suggestion-trigger",
          allow: ({ state, range }) => isSlashCommandPosition(state, range.from),
          items: source.items,
          render: source.render,
          command: ({ editor, range, props }) => {
            props.run(editor, range);
          },
        }),
      ];
    },
  });
}
