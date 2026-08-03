"use client";

import { suggestionAnnouncement } from "./suggestion-popup";
import { SuggestionPopover } from "./SuggestionPopover";

import type { MentionCandidate } from "./mention-members";
import type { SuggestionPopupState } from "./suggestion-popup";
import type { Editor } from "@tiptap/core";

export const MENTION_LISTBOX_ID = "notted-mention-menu";
export const MENTION_LIST_LABEL = "Workspace members";

/** Shown when every workspace member is loaded, so "no match" means "nobody". */
export const MENTION_EMPTY_MESSAGE = "No workspace members match. Press Escape to keep typing.";

/**
 * Shown when the loaded member list is known to be incomplete. "No match" then
 * only means "not among the members loaded", which is not the same claim as
 * "not in this workspace", so the two are never worded the same way.
 */
export const MENTION_TRUNCATED_EMPTY_MESSAGE =
  "No match among the workspace members loaded so far. Not every member is loaded, so this does not mean the person is absent. Press Escape to keep typing.";

export interface MentionListProps {
  readonly editor: Editor | null;
  readonly state: SuggestionPopupState<MentionCandidate>;
  /** True when the host stopped short of loading every workspace member. */
  readonly truncated?: boolean;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly onDismiss: () => void;
}

/**
 * The `@` menu.
 *
 * Every candidate comes from the authorized, workspace-scoped member listing
 * the host passes in; this component never fetches and never widens a search.
 */
export function MentionList({
  editor,
  state,
  truncated = false,
  onSelect,
  onActivate,
  onDismiss,
}: MentionListProps) {
  return (
    <SuggestionPopover<MentionCandidate>
      editor={editor}
      state={state}
      listboxId={MENTION_LISTBOX_ID}
      label={MENTION_LIST_LABEL}
      announcement={suggestionAnnouncement(state, { singular: "member", plural: "members" })}
      loadingMessage="Searching workspace members…"
      emptyMessage={truncated ? MENTION_TRUNCATED_EMPTY_MESSAGE : MENTION_EMPTY_MESSAGE}
      errorMessage="Workspace members could not be loaded. Press Escape to keep typing."
      itemKey={(member) => member.userId}
      renderItem={(member) => (
        <span className="min-w-0">
          <span className="block truncate font-medium">{member.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {member.email} · {member.role}
          </span>
        </span>
      )}
      onSelect={onSelect}
      onActivate={onActivate}
      onDismiss={onDismiss}
    />
  );
}
