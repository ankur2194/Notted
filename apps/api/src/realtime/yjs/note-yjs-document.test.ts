import { safeParseNoteDocument } from "@notted/shared-validators";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  NOTE_YJS_FIELD,
  NoteYjsConversionError,
  noteDocumentToYDoc,
  yDocToNoteDocument,
} from "./note-yjs-document";

// This file is the de-risking test for Part 58. The conversion in
// `note-yjs-document.ts` is a transcription of `y-prosemirror`'s conventions,
// and the browser writes the SAME shared type with the real library, so a
// mapping bug here is silent content corruption rather than an error. Every
// node type and every mark the editor can produce is round-tripped below.

const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID = "22222222-2222-4222-8222-222222222222";
const MENTION_ID = "33333333-3333-4333-8333-333333333333";
const SAFE_LINK_REL = "noopener noreferrer nofollow";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function docOf(...blocks: JsonRecord[]): JsonRecord {
  return { type: "doc", content: blocks };
}

function text(value: string, ...marks: JsonRecord[]): JsonRecord {
  return marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(...content: JsonRecord[]): JsonRecord {
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

/**
 * The two documented asymmetries of the conversion, applied to the INPUT so the
 * round trip compares like with like:
 *
 *   1. `noteDocumentToYDoc` drops NODE attributes whose value is `null`,
 *      because `y-prosemirror` does (a null attribute means "the ProseMirror
 *      default"). MARK attributes are deliberately untouched: they travel
 *      inside the text delta as opaque JSON, nulls and all.
 *   2. `yDocToNoteDocument` omits an `attrs` or `content` key that would come
 *      back empty, because a node with no attributes and no children writes
 *      neither.
 *
 * Anything outside those two rules must survive byte-for-byte.
 */
function normalize(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const normalized: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "attrs" && isRecord(value)) {
      const attrs = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
      if (Object.keys(attrs).length > 0) normalized.attrs = attrs;
      continue;
    }
    if (key === "content" && Array.isArray(value)) {
      if (value.length > 0) normalized.content = value.map(normalize);
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

/**
 * Assert the fixture is a document the API would actually accept, then assert
 * the round trip. The first assertion matters: a fixture `safeParseNoteDocument`
 * rejects would make the round-trip assertion meaningless.
 */
function expectRoundTrip(document: JsonRecord): void {
  expect(safeParseNoteDocument(document).errors).toEqual([]);
  expect(yDocToNoteDocument(noteDocumentToYDoc(document))).toEqual(normalize(document));
}

describe("note document ↔ Yjs round trip", () => {
  it("round-trips a paragraph with a text alignment", () => {
    expectRoundTrip(
      docOf(
        { type: "paragraph", attrs: { textAlign: "center" }, content: [text("Centered")] },
        { type: "paragraph", attrs: { textAlign: "justify" }, content: [text("Justified")] },
        // `textAlign: null` is the default; it must NOT survive into Yjs.
        { type: "paragraph", attrs: { textAlign: null }, content: [text("Default")] },
      ),
    );
  });

  it("round-trips every heading level", () => {
    expectRoundTrip(
      docOf(
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
          type: "heading",
          attrs: { level, textAlign: null },
          content: [text(`Heading ${String(level)}`)],
        })),
      ),
    );
  });

  it("round-trips a heading that also carries an alignment", () => {
    expectRoundTrip(
      docOf({ type: "heading", attrs: { level: 2, textAlign: "right" }, content: [text("Right")] }),
    );
  });

  it("round-trips bullet and ordered lists", () => {
    expectRoundTrip(
      docOf(
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph(text("first bullet"))] },
            { type: "listItem", content: [paragraph(text("second bullet"))] },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 3, type: null },
          content: [{ type: "listItem", content: [paragraph(text("third item"))] }],
        },
      ),
    );
  });

  it("round-trips a blockquote", () => {
    expectRoundTrip(docOf({ type: "blockquote", content: [paragraph(text("Quoted."))] }));
  });

  it("round-trips a code block with a language", () => {
    expectRoundTrip(
      docOf({
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [text("const answer = 42;")],
      }),
    );
  });

  it("round-trips a nested task list with both checked states", () => {
    expectRoundTrip(
      docOf({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              paragraph(text("Ship the schema")),
              {
                type: "taskList",
                content: [
                  {
                    type: "taskItem",
                    attrs: { checked: false },
                    content: [paragraph(text("Ship the converter"))],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
  });

  it("round-trips a table with spans and column widths", () => {
    expectRoundTrip(
      docOf({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colspan: 2, rowspan: 1, colwidth: [120, 180] },
                content: [paragraph(text("Header"))],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 2, colwidth: null },
                content: [paragraph(text("A"))],
              },
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                content: [paragraph(text("B"))],
              },
            ],
          },
        ],
      }),
    );
  });

  it("round-trips stateless block leaves", () => {
    expectRoundTrip(
      docOf(paragraph(text("above")), { type: "pageBreak" }, { type: "horizontalRule" }),
    );
  });

  it("round-trips a hard break between two text runs", () => {
    expectRoundTrip(docOf(paragraph(text("before"), { type: "hardBreak" }, text("after"))));
  });

  it("round-trips an image with its layout attributes", () => {
    expectRoundTrip(
      docOf({
        type: "image",
        attrs: {
          attachmentId: IMAGE_ID,
          alt: "Chart of monthly revenue",
          width: 640,
          height: null,
          align: "left",
          wrap: "inline",
          fullWidth: false,
          caption: "Revenue, month over month",
        },
      }),
    );
  });

  it("round-trips an attachment card", () => {
    expectRoundTrip(
      docOf({
        type: "attachment",
        attrs: {
          attachmentId: ATTACHMENT_ID,
          name: "quarterly-report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2_048,
        },
      }),
    );
  });

  it("round-trips an inline mention between text runs", () => {
    expectRoundTrip(
      docOf(
        paragraph(
          text("Assigned to "),
          { type: "mention", attrs: { id: MENTION_ID, label: "Ada Lovelace" } },
          text(" for review."),
        ),
      ),
    );
  });

  // Each run carries a DIFFERENT mark set on purpose: Yjs merges adjacent
  // inserts whose formatting is identical, so two neighbouring runs with the
  // same marks would legitimately come back as one text node.
  it("round-trips every mark type", () => {
    expectRoundTrip(
      docOf(
        paragraph(
          text("bold", { type: "bold" }),
          text("italic", { type: "italic" }),
          text("underline", { type: "underline" }),
          text("strike", { type: "strike" }),
          text("code", { type: "code" }),
          text("link", {
            type: "link",
            attrs: {
              href: "https://example.com/docs",
              target: "_blank",
              rel: SAFE_LINK_REL,
              class: null,
            },
          }),
          text("highlight", { type: "highlight", attrs: { color: "#ffff00" } }),
          text("default highlight", { type: "highlight" }),
          text("colored", { type: "textStyle", attrs: { color: "#112233" } }),
          text("sized", { type: "textStyle", attrs: { fontSize: "18px" } }),
          text("sub", { type: "subscript" }),
          text("sup", { type: "superscript" }),
        ),
      ),
    );
  });

  it("keeps a null mark attribute, unlike a null node attribute", () => {
    const document = docOf(
      paragraph(
        text("link", {
          type: "link",
          attrs: {
            href: "https://example.com/docs",
            target: "_blank",
            rel: SAFE_LINK_REL,
            class: null,
          },
        }),
      ),
    );
    const projected = yDocToNoteDocument(noteDocumentToYDoc(document)) as {
      content: [{ content: [{ marks: [{ attrs: Record<string, unknown> }] }] }];
    };
    expect(projected.content[0].content[0].marks[0].attrs.class).toBeNull();
  });

  it("splits one text run into three nodes at mark boundaries", () => {
    const split = docOf(paragraph(text("plain "), text("bold", { type: "bold" }), text(" tail")));
    expectRoundTrip(split);

    const projected = yDocToNoteDocument(noteDocumentToYDoc(split)) as {
      content: [{ content: unknown[] }];
    };
    expect(projected.content[0].content).toHaveLength(3);
  });

  it("round-trips an empty document", () => {
    expectRoundTrip(docOf(paragraph()));
  });

  it("round-trips a document that mixes every block type at once", () => {
    expectRoundTrip(
      docOf(
        { type: "heading", attrs: { level: 1, textAlign: null }, content: [text("Title")] },
        paragraph(text("Intro "), text("emphasis", { type: "italic" })),
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph(text("point"))] }],
        },
        { type: "codeBlock", attrs: { language: "json" }, content: [text('{"a":1}')] },
        { type: "horizontalRule" },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [paragraph(text("open item"))],
            },
          ],
        },
        { type: "pageBreak" },
        paragraph(text("End.")),
      ),
    );
  });

  it("rejects an unknown node type instead of silently dropping it", () => {
    const unknownNode = docOf({ type: "notARealNode" });
    expect(() => noteDocumentToYDoc(unknownNode)).toThrow(NoteYjsConversionError);
  });

  it("rejects a non-document input", () => {
    expect(() => noteDocumentToYDoc({ type: "paragraph" })).toThrow(NoteYjsConversionError);
    expect(() => noteDocumentToYDoc(null)).toThrow(NoteYjsConversionError);
  });

  it("rejects a shared type whose text delta inserts an embed", () => {
    const doc = new Y.Doc();
    const paragraphElement = new Y.XmlElement("paragraph");
    const embedText = new Y.XmlText();
    paragraphElement.insert(0, [embedText]);
    doc.getXmlFragment(NOTE_YJS_FIELD).insert(0, [paragraphElement]);
    embedText.insertEmbed(0, { image: "nope" });

    expect(() => yDocToNoteDocument(doc)).toThrow(NoteYjsConversionError);
  });
});

describe("shared-type interop", () => {
  // The whole point of Yjs: the projection must depend only on the encoded
  // update, never on the in-process objects that produced it. If this fails,
  // the browser (which only ever sees the encoded bytes) would decode something
  // different from what the server just wrote.
  it("projects identically after an encode/apply cycle into a fresh doc", () => {
    const document = docOf(
      { type: "heading", attrs: { level: 3, textAlign: "center" }, content: [text("Shared")] },
      paragraph(
        text("hello "),
        { type: "mention", attrs: { id: MENTION_ID, label: "Ada Lovelace" } },
        text(" and "),
        text("bold", { type: "bold" }),
      ),
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: [240] },
                content: [paragraph(text("cell"))],
              },
            ],
          },
        ],
      },
      { type: "pageBreak" },
    );

    const source = noteDocumentToYDoc(document);
    const update = Y.encodeStateAsUpdate(source);

    const target = new Y.Doc();
    Y.applyUpdate(target, update);

    expect(yDocToNoteDocument(target)).toEqual(yDocToNoteDocument(source));
    expect(yDocToNoteDocument(target)).toEqual(normalize(document));
  });

  it("writes the top-level blocks into the shared field the editor reads", () => {
    const doc = noteDocumentToYDoc(docOf(paragraph(text("one")), { type: "horizontalRule" }));
    const fragment = doc.getXmlFragment(NOTE_YJS_FIELD);

    expect(fragment.toArray()).toHaveLength(2);
    expect(fragment.get(0)).toBeInstanceOf(Y.XmlElement);
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe("paragraph");
    expect((fragment.get(1) as Y.XmlElement).nodeName).toBe("horizontalRule");
  });
});
