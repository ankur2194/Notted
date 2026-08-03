import {
  NOTE_DOCUMENT_CODE_LANGUAGES,
  NOTE_DOCUMENT_MARK_TYPES,
  NOTE_DOCUMENT_NODE_TYPES,
  safeParseNoteDocument,
} from "@notted/shared-validators";
import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser, DOMSerializer } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { isAllowedDocumentLink } from "../document-contract";

import {
  CODE_BLOCK_LANGUAGE_OPTIONS,
  NOTE_FONT_SIZES,
  createNoteEditorExtensions,
  createNoteLowlight,
  isAllowedNoteFontSize,
} from "./index";

const SAFE_LINK_ATTRS = {
  href: "https://example.com/note",
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
} as const;

const richDocumentFixture = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2, textAlign: "center" },
      content: [{ type: "text", text: "Rich heading", marks: [{ type: "bold" }] }],
    },
    {
      type: "paragraph",
      attrs: { textAlign: "justify" },
      content: [
        { type: "text", text: "under", marks: [{ type: "underline" }] },
        {
          type: "text",
          text: " styled",
          marks: [{ type: "textStyle", attrs: { color: "#123456", fontSize: "16px" } }],
        },
        {
          type: "text",
          text: " highlighted",
          marks: [{ type: "highlight", attrs: { color: "#abcdef" } }],
        },
        { type: "text", text: " linked", marks: [{ type: "link", attrs: SAFE_LINK_ATTRS }] },
        { type: "text", text: " sub", marks: [{ type: "subscript" }] },
        { type: "text", text: " super", marks: [{ type: "superscript" }] },
        { type: "text", text: " italic", marks: [{ type: "italic" }] },
        { type: "text", text: " strike", marks: [{ type: "strike" }] },
        { type: "text", text: " code", marks: [{ type: "code" }] },
        { type: "hardBreak" },
        { type: "text", text: "after break" },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet" }] }],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 3, type: null },
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Ordered" }] }],
        },
      ],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Task" }] }],
        },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Quote" }] }],
    },
    { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "code()" }] },
    { type: "horizontalRule" },
  ],
};

function serializeDocument(documentJson: object): string {
  const schema = getSchema(createNoteEditorExtensions());
  const node = schema.nodeFromJSON(documentJson);
  const container = document.createElement("div");
  container.append(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
  return container.innerHTML;
}

function roundTripDocument(documentJson: object): Record<string, unknown> {
  const schema = getSchema(createNoteEditorExtensions());
  const node = schema.nodeFromJSON(documentJson);
  node.check();
  const output = node.toJSON() as Record<string, unknown>;
  schema.nodeFromJSON(output).check();
  return output;
}

function firstTextMarkAttrs(
  documentJson: object,
  markName: string,
): Record<string, unknown> | null {
  const schema = getSchema(createNoteEditorExtensions());
  const node = schema.nodeFromJSON(documentJson);
  const mark = node.firstChild?.firstChild?.marks.find(
    (candidate) => candidate.type.name === markName,
  );
  return mark === undefined ? null : { ...mark.attrs };
}

function parseFontSizeFromHtml(fontSize: string): unknown {
  const schema = getSchema(createNoteEditorExtensions());
  const container = document.createElement("div");
  container.innerHTML = `<p><span style="font-size: ${fontSize}">text</span></p>`;
  const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(container);
  const textStyle = parsed.firstChild?.firstChild?.marks.find(
    (mark) => mark.type.name === "textStyle",
  );
  return textStyle?.attrs.fontSize;
}

describe("note editor extensions", () => {
  it("keeps the intentionally empty document compatible with ProseMirror", () => {
    const output = roundTripDocument({ type: "doc", content: [] });
    expect(output).toEqual({ type: "doc" });
    expect(safeParseNoteDocument(output).success).toBe(true);
  });

  it("round-trips rich schema through ProseMirror checks and shared validation", () => {
    const schema = getSchema(createNoteEditorExtensions());
    const original = schema.nodeFromJSON(richDocumentFixture);
    original.check();
    const output = original.toJSON();
    const reparsed = schema.nodeFromJSON(output);
    reparsed.check();

    expect(safeParseNoteDocument(output).success).toBe(true);
    expect(reparsed.toJSON()).toEqual(output);
    expect(reparsed.textContent).toBe(original.textContent);
    expect(Object.keys(schema.nodes)).toEqual(
      expect.arrayContaining([...NOTE_DOCUMENT_NODE_TYPES]),
    );
    expect(Object.keys(schema.marks)).toEqual(
      expect.arrayContaining([...NOTE_DOCUMENT_MARK_TYPES]),
    );
    expect(schema.marks.color).toBeUndefined();
  });

  it("serializes a font-size-only textStyle with the actual nullable color default", () => {
    const output = roundTripDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "size",
              marks: [{ type: "textStyle", attrs: { fontSize: "16px" } }],
            },
          ],
        },
      ],
    });
    expect(safeParseNoteDocument(output).success).toBe(true);
    expect(firstTextMarkAttrs(output, "textStyle")).toEqual({ color: null, fontSize: "16px" });
    expect(serializeDocument(output)).toContain("font-size: 16px");
    expect(serializeDocument(output)).not.toContain("color: null");
  });

  it("serializes a color-only textStyle with the actual nullable font-size default", () => {
    const output = roundTripDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "color",
              marks: [{ type: "textStyle", attrs: { color: "#123456" } }],
            },
          ],
        },
      ],
    });
    expect(safeParseNoteDocument(output).success).toBe(true);
    expect(firstTextMarkAttrs(output, "textStyle")).toEqual({
      color: "#123456",
      fontSize: null,
    });
    expect(serializeDocument(output)).toContain("color: rgb(18, 52, 86)");
    expect(serializeDocument(output)).not.toContain("font-size: null");
  });

  it("accepts TipTap's schema-valid empty textStyle defaults at the shared boundary", () => {
    const output = roundTripDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "plain",
              marks: [{ type: "textStyle", attrs: { color: null, fontSize: null } }],
            },
          ],
        },
      ],
    });

    expect(firstTextMarkAttrs(output, "textStyle")).toEqual({ color: null, fontSize: null });
    expect(safeParseNoteDocument(output).success).toBe(true);
    expect(serializeDocument(output)).toBe("<p><span>plain</span></p>");
  });

  it("serializes default highlight as color null and renders a plain mark element", () => {
    const output = roundTripDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "default", marks: [{ type: "highlight" }] }],
        },
      ],
    });
    expect(safeParseNoteDocument(output).success).toBe(true);
    expect(firstTextMarkAttrs(output, "highlight")).toEqual({ color: null });
    expect(serializeDocument(output)).toContain("<mark>default</mark>");
  });

  it("serializes ordered-list and alignment nullable defaults accepted by the contract", () => {
    const output = roundTripDocument({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain" }] },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
        },
      ],
    });
    expect(output).toMatchObject({
      content: [
        { type: "paragraph", attrs: { textAlign: null } },
        { type: "orderedList", attrs: { start: 1, type: null } },
      ],
    });
    expect(safeParseNoteDocument(output).success).toBe(true);
  });

  it("allows only the exact Notted font-size set and omits invalid values from HTML", () => {
    for (const fontSize of NOTE_FONT_SIZES) {
      expect(isAllowedNoteFontSize(fontSize)).toBe(true);
      expect(parseFontSizeFromHtml(fontSize)).toBe(fontSize);
      expect(
        serializeDocument({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: fontSize,
                  marks: [{ type: "textStyle", attrs: { fontSize } }],
                },
              ],
            },
          ],
        }),
      ).toContain(`font-size: ${fontSize}`);
    }

    expect(isAllowedNoteFontSize("13px")).toBe(false);
    expect(isAllowedNoteFontSize("16")).toBe(false);
    expect(parseFontSizeFromHtml("13px") ?? null).toBeNull();
    expect(
      serializeDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "invalid",
                marks: [{ type: "textStyle", attrs: { fontSize: "13px" } }],
              },
            ],
          },
        ],
      }),
    ).not.toContain("font-size");
  });

  it("persists and renders exactly the canonical safe link attributes", () => {
    expect(isAllowedDocumentLink("https://example.com/note")).toBe(true);
    expect(isAllowedDocumentLink("mailto:notes@example.com")).toBe(true);
    expect(isAllowedDocumentLink("javascript:alert(1)")).toBe(false);

    const output = roundTripDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "safe link",
              marks: [{ type: "link", attrs: { href: "https://example.com/note" } }],
            },
          ],
        },
      ],
    });
    expect(firstTextMarkAttrs(output, "link")).toEqual(SAFE_LINK_ATTRS);
    expect(safeParseNoteDocument(output).success).toBe(true);
    const html = serializeDocument(output);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

const tableFixture = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Head" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1, colwidth: [200] },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("Part 35 editor schema additions", () => {
  it("round-trips a resizable table through ProseMirror and the shared contract", () => {
    const output = roundTripDocument(tableFixture);
    // ProseMirror fills in the paragraph's nullable alignment default; the
    // structure and every reviewed cell attribute survive unchanged.
    expect(output).toMatchObject(tableFixture);
    expect(safeParseNoteDocument(output).success).toBe(true);
    const html = serializeDocument(output);
    expect(html).toContain("<td");
    expect(html).toContain("<th");
  });

  it("registers exactly the contract's code languages with lowlight", () => {
    const registered = [...createNoteLowlight().listLanguages()].sort();
    expect(registered).toEqual([...NOTE_DOCUMENT_CODE_LANGUAGES].sort());

    const offered = CODE_BLOCK_LANGUAGE_OPTIONS.map((option) => option.value).sort();
    expect(offered).toEqual([...NOTE_DOCUMENT_CODE_LANGUAGES].sort());
    expect(new Set(CODE_BLOCK_LANGUAGE_OPTIONS.map((option) => option.label)).size).toBe(
      CODE_BLOCK_LANGUAGE_OPTIONS.length,
    );
  });

  it("keeps the block-behaviour extensions registered exactly once", () => {
    const names = createNoteEditorExtensions().map((extension) => extension.name);
    for (const required of [
      "table",
      "tableRow",
      "tableHeader",
      "tableCell",
      "taskList",
      "taskItem",
      "codeBlock",
      "placeholder",
      "nottedBlockTab",
      "nottedSlashCommand",
      "mention",
    ]) {
      expect(names.filter((name) => name === required)).toHaveLength(1);
    }
  });
});

const MENTION_USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

const mentionFixture = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { textAlign: null },
      content: [
        { type: "text", text: "cc " },
        { type: "mention", attrs: { id: MENTION_USER_ID, label: "Ada Lovelace" } },
      ],
    },
  ],
};

describe("Part 36 editor schema additions", () => {
  it("round-trips a mention through ProseMirror and the shared contract", () => {
    const output = roundTripDocument(mentionFixture);
    expect(output).toMatchObject(mentionFixture);
    expect(safeParseNoteDocument(output).success).toBe(true);
  });

  it("persists exactly the two reviewed mention attributes", () => {
    const schema = getSchema(createNoteEditorExtensions());
    const node = schema.nodeFromJSON(mentionFixture);
    const mention = node.firstChild?.lastChild;
    // TipTap's stock extension also stores `mentionSuggestionChar`, which the
    // shared contract rejects; the attribute set is replaced, not extended.
    expect(Object.keys(mention?.attrs ?? {}).sort()).toEqual(["id", "label"]);
    expect(mention?.isAtom).toBe(true);
    expect(mention?.isInline).toBe(true);
  });

  it("serializes a hostile label as inert text, never as markup", () => {
    const html = serializeDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: MENTION_USER_ID, label: '<script>alert("x")</script>' },
            },
          ],
        },
      ],
    });
    expect(html).toContain('data-type="mention"');
    expect(html).toContain(`data-mention-id="${MENTION_USER_ID}"`);
    expect(html).not.toContain("mentionSuggestionChar");

    // Re-parsing the serialized output must yield one span and no element the
    // label was able to introduce. `data-mention-label` survives as an ordinary
    // attribute so a clipboard round-trip inside the editor keeps the name.
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelectorAll("script")).toHaveLength(0);
    const span = container.querySelector('[data-type="mention"]');
    expect(span?.children).toHaveLength(0);
    expect(span?.textContent).toBe('@<script>alert("x")</script>');
  });
});
