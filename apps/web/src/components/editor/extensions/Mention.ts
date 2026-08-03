/**
 * Workspace member mentions.
 *
 * `Notted.md`'s canonical structure names this file `extensions/Mention.ts`
 * with a capital M even though it is not a React component. `Notted.md` is
 * primary for directory structure, so the spec's spelling wins over the
 * kebab-case rule for `.ts` files in `CLAUDE.md`.
 */

import {
  NOTE_DOCUMENT_MENTION_CLASS,
  NOTE_DOCUMENT_MENTION_PREFIX,
  noteDocumentMentionAttrs,
} from "@notted/shared-validators";
import { mergeAttributes } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";

import { MENTION_TRIGGER, isMentionPosition } from "../suggestion-triggers";

import { createSuggestionSource } from "./suggestion-bridge";

import type { MentionCandidate, MentionDirectory } from "../mention-members";
import type { SuggestionSink } from "../suggestion-popup";
import type { MentionOptions } from "@tiptap/extension-mention";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * The extension's options, narrowed so both suggestion generics are the
 * workspace-member candidate. TipTap's own defaults leave the item type as
 * `any` and the selected type as its stock attribute shape, neither of which
 * matches the two-attribute node this contract stores.
 */
type NoteMentionOptions = MentionOptions<MentionCandidate, MentionCandidate>;

export const MENTION_EXTENSION_NAME = "mention";

/** Above `NoteBlockTab` (200) for the same reason as the slash menu. */
export const MENTION_PRIORITY = 220;

/** Class marking a mention whose user is no longer a workspace member. */
export const MENTION_REMOVED_CLASS = "notted-mention--removed";

export const MENTION_REMOVED_SUFFIX = " (former member)";
export const MENTION_REMOVED_TITLE = "This person is no longer in this workspace.";

export interface NoteMentionConfig {
  readonly resolveSink?: () => SuggestionSink<MentionCandidate> | null;
  /** Injected so the editor itself performs no network I/O. */
  readonly search?: (query: string) => Promise<readonly MentionCandidate[]>;
  /** Current workspace members, used only to render a mention readably. */
  readonly directory?: MentionDirectory | null;
}

function storedLabel(node: ProseMirrorNode): string {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null) return attrs.label;
  const raw: unknown = node.attrs.label;
  return typeof raw === "string" ? raw : "";
}

function storedId(node: ProseMirrorNode): string | null {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null) return attrs.id;
  const raw: unknown = node.attrs.id;
  return typeof raw === "string" ? raw : null;
}

export function mentionDisplayText(node: ProseMirrorNode): string {
  return `${NOTE_DOCUMENT_MENTION_PREFIX}${storedLabel(node)}`;
}

/**
 * Paint one mention span from the node and the loaded member list.
 *
 * Three cases, and the difference between them matters:
 *
 * - **current member** — show the member's *current* name, so a rename is
 *   reflected without rewriting stored documents;
 * - **former member** — the id is not in the loaded list, so show the cached
 *   label, mark it visually, and say why in text a screen reader reads. Nothing
 *   beyond the already-stored label is disclosed;
 * - **unknown** — the list has not loaded or is unavailable. Show the cached
 *   label plainly and claim nothing, because an unavailable list is not
 *   evidence that anyone was removed.
 */
export function paintMention(
  dom: HTMLElement,
  node: ProseMirrorNode,
  directory: MentionDirectory | null,
): void {
  const id = storedId(node);
  const cached = storedLabel(node);
  const resolution =
    id === null || directory === null ? { kind: "unknown" as const } : directory.resolve(id);

  dom.setAttribute("data-type", MENTION_EXTENSION_NAME);
  dom.setAttribute("data-mention-state", resolution.kind);
  if (id === null) dom.removeAttribute("data-mention-id");
  else dom.setAttribute("data-mention-id", id);
  // Set as an attribute rather than through the IDL property: jsdom does not
  // reflect `contentEditable`, and ProseMirror reads the attribute anyway.
  dom.setAttribute("contenteditable", "false");
  dom.className =
    resolution.kind === "former"
      ? `${NOTE_DOCUMENT_MENTION_CLASS} ${MENTION_REMOVED_CLASS}`
      : NOTE_DOCUMENT_MENTION_CLASS;

  const name = resolution.kind === "current" ? resolution.name : cached;
  dom.replaceChildren(document.createTextNode(`${NOTE_DOCUMENT_MENTION_PREFIX}${name}`));

  if (resolution.kind === "former") {
    dom.title = MENTION_REMOVED_TITLE;
    const note = document.createElement("span");
    note.className = "sr-only";
    note.textContent = MENTION_REMOVED_SUFFIX;
    dom.append(note);
  } else {
    dom.removeAttribute("title");
  }
}

/**
 * Build the mention node for one editor instance.
 *
 * Only `id` and `label` are persisted. TipTap's stock extension also stores a
 * `mentionSuggestionChar` attribute, which the shared document contract does
 * not allow, so the attribute set is replaced outright rather than extended.
 */
export function createNoteMention(config: NoteMentionConfig = {}) {
  const resolveSink = config.resolveSink ?? ((): null => null);
  const search = config.search ?? ((): Promise<readonly MentionCandidate[]> => Promise.resolve([]));
  const directory = config.directory ?? null;
  const source = createSuggestionSource<MentionCandidate>(resolveSink, (query) => search(query));

  return Mention.extend<NoteMentionOptions>({
    priority: MENTION_PRIORITY,

    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-mention-id"),
          renderHTML: (attributes: Record<string, unknown>) =>
            typeof attributes.id === "string" ? { "data-mention-id": attributes.id } : {},
        },
        label: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-mention-label"),
          renderHTML: (attributes: Record<string, unknown>) =>
            typeof attributes.label === "string" ? { "data-mention-label": attributes.label } : {},
        },
      };
    },

    parseHTML() {
      return [{ tag: `span[data-type="${MENTION_EXTENSION_NAME}"]` }];
    },

    renderHTML({ node, HTMLAttributes }) {
      // A ProseMirror DOM output spec sets the label through `textContent`, so
      // the untrusted cached name is never interpolated into markup here. The
      // server-side projection escapes it independently in `renderDocumentHtml`.
      return [
        "span",
        mergeAttributes(
          { "data-type": MENTION_EXTENSION_NAME, class: NOTE_DOCUMENT_MENTION_CLASS },
          HTMLAttributes,
        ),
        mentionDisplayText(node),
      ];
    },

    renderText({ node }) {
      return mentionDisplayText(node);
    },

    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("span");
        let current = node;
        const repaint = (): void => paintMention(dom, current, directory);
        repaint();
        const unsubscribe = directory?.subscribe(repaint) ?? null;
        return {
          dom,
          ignoreMutation: () => true,
          update: (nextNode) => {
            if (nextNode.type.name !== MENTION_EXTENSION_NAME) return false;
            current = nextNode;
            repaint();
            return true;
          },
          destroy: () => {
            unsubscribe?.();
          },
        };
      };
    },

    addKeyboardShortcuts() {
      return {
        // TipTap 2.27.1's own Backspace handler runs its replacement twice
        // against unmapped positions, which removes the character after the
        // mention as well. A mention is an atom, so deleting the whole node
        // once is both the correct behaviour and the simpler rule.
        Backspace: () =>
          this.editor.commands.command(({ tr, state }) => {
            const { empty, anchor } = state.selection;
            if (!empty) return false;
            let handled = false;
            state.doc.nodesBetween(anchor - 1, anchor, (candidate, pos) => {
              if (handled || candidate.type.name !== MENTION_EXTENSION_NAME) return !handled;
              handled = true;
              tr.delete(pos, pos + candidate.nodeSize);
              return false;
            });
            return handled;
          }),
      };
    },
  }).configure({
    suggestion: {
      char: MENTION_TRIGGER,
      pluginKey: new PluginKey(`${MENTION_EXTENSION_NAME}Suggestion`),
      decorationClass: "notted-suggestion-trigger",
      allow: ({ state, range }) => isMentionPosition(state, range.from, MENTION_EXTENSION_NAME),
      items: source.items,
      render: source.render,
      command: ({ editor, range, props }) => {
        // A mention is always followed by one space. When the trigger is
        // already followed by a space, that existing one is consumed instead so
        // the caret does not end up behind a double space.
        const nodeAfter = editor.view.state.selection.$to.nodeAfter;
        const to = nodeAfter?.text?.startsWith(" ") === true ? range.to + 1 : range.to;
        // Store the stable user id; the label is only a display snapshot.
        editor
          .chain()
          .focus()
          .insertContentAt({ from: range.from, to }, [
            { type: MENTION_EXTENSION_NAME, attrs: { id: props.userId, label: props.name } },
            { type: "text", text: " " },
          ])
          .run();
      },
    },
  });
}
