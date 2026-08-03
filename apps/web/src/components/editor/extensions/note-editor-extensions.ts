import { sanitizeDocumentUrl } from "@notted/shared-validators";
import { Node, type Extensions } from "@tiptap/core";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Link } from "@tiptap/extension-link";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { StarterKit } from "@tiptap/starter-kit";

import { FontSize } from "./font-size";

const SAFE_LINK_REL = "noopener noreferrer nofollow";
const NoteDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "block*",
});

function createSafeLinkExtension() {
  return Link.extend({
    // Persist exactly the link attributes accepted by the shared contract.
    addAttributes() {
      return {
        href: {
          default: null,
          parseHTML: (element: HTMLElement) => sanitizeDocumentUrl(element.getAttribute("href")),
        },
        target: {
          default: "_blank",
          parseHTML: () => "_blank",
        },
        rel: {
          default: SAFE_LINK_REL,
          parseHTML: () => SAFE_LINK_REL,
        },
        class: {
          default: null,
          parseHTML: () => null,
        },
      };
    },
  }).configure({
    openOnClick: false,
    HTMLAttributes: {
      rel: SAFE_LINK_REL,
      target: "_blank",
    },
    validate: (url) => sanitizeDocumentUrl(url) !== null,
    isAllowedUri: (url) => sanitizeDocumentUrl(url) !== null,
    shouldAutoLink: (url) => sanitizeDocumentUrl(url) !== null,
  });
}

function createTaskItemSchemaExtension() {
  return TaskItem.extend({
    // Part 33 needs persisted schema support only. Part 35 owns checklist
    // node views, markdown conversion, and Tab/Shift+Tab/Enter behavior.
    addNodeView: null,
    addInputRules() {
      return [];
    },
    addKeyboardShortcuts() {
      return {};
    },
  }).configure({ nested: true });
}

/** Build an isolated schema configuration for each future editor instance. */
export function createNoteEditorExtensions(): Extensions {
  return [
    StarterKit.configure({
      document: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // Part 35 owns cursor-specific block behavior.
      dropcursor: false,
      gapcursor: false,
    }),
    NoteDocument,
    Underline.configure({}),
    TextStyle.configure({}),
    TextAlign.configure({
      types: ["paragraph", "heading"],
      alignments: ["left", "center", "right", "justify"],
    }),
    Color.configure({ types: ["textStyle"] }),
    Highlight.configure({ multicolor: true }),
    Subscript.configure({}),
    Superscript.configure({}),
    createSafeLinkExtension(),
    TaskList.configure({}),
    createTaskItemSchemaExtension(),
    FontSize.configure({}),
  ];
}
