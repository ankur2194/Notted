// Every assertion here reads the REAL artefact: `renderDocx` produces a ZIP, so
// the test unzips it and asserts against `word/document.xml` (or `header1.xml` /
// `footer1.xml`). Asserting against the object tree `docx` was handed would only
// prove this file and the renderer agree with each other; asserting against the
// packed XML proves the bytes a reader opens are the bytes we meant.

import { clampMargins, pageDimensionsMm } from "@notted/shared-types";
import { NOTE_DOCUMENT_NODE_TYPES, formatBinaryBytes } from "@notted/shared-validators";
import { convertMillimetersToTwip } from "docx";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { renderDocx } from "./docx";

import type { ExportSourceDocument, ExportSourceSubject } from "../export-renderers";
import type { ExportOptions, PageSize } from "@notted/shared-types";

const SUBJECT: ExportSourceSubject = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  noteId: "22222222-2222-4222-8222-222222222222",
  requestedById: "33333333-3333-4333-8333-333333333333",
  correlationId: null,
};

const MENTION_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";

const OPTIONS: ExportOptions = {
  includeAttachments: false,
  includeComments: false,
  includeVersionHistory: false,
  headerText: null,
  footerText: null,
  margins: null,
};

function source(
  content: unknown,
  overrides: Partial<ExportSourceDocument> = {},
): ExportSourceDocument {
  return {
    title: "Note",
    content,
    options: OPTIONS,
    pageSize: "a4",
    subject: SUBJECT,
    ...overrides,
  };
}

async function partsOf(
  content: unknown,
  overrides: Partial<ExportSourceDocument> = {},
): Promise<Record<string, string>> {
  const artifact = await renderDocx(source(content, overrides));
  const files = unzipSync(new Uint8Array(artifact.body));
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, strFromU8(bytes)]));
}

/** `word/document.xml` for a document. The single most-used helper in this file. */
async function bodyXml(
  content: unknown,
  overrides: Partial<ExportSourceDocument> = {},
): Promise<string> {
  return (await partsOf(content, overrides))["word/document.xml"] ?? "";
}

function doc(...nodes: readonly unknown[]): unknown {
  return { type: "doc", content: nodes };
}

function text(value: string, marks?: readonly unknown[]): unknown {
  return { type: "text", text: value, ...(marks === undefined ? {} : { marks }) };
}

function para(...children: readonly unknown[]): unknown {
  return { type: "paragraph", content: children };
}

describe("renderDocx artefact", () => {
  it("carries the shared docx media facts and a frozen, non-empty body", async () => {
    const artifact = await renderDocx(source(doc(para(text("hello")))));

    expect(artifact.fileExtension).toBe("docx");
    expect(artifact.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(Object.isFrozen(artifact)).toBe(true);
    // A real OOXML package, not an empty or truncated buffer.
    expect(Object.keys(unzipSync(new Uint8Array(artifact.body)))).toContain("word/document.xml");
  });

  it("renders the note title as the document's title heading", async () => {
    const xml = await bodyXml(doc(para(text("body"))), { title: "Quarterly plan" });

    expect(xml).toContain('<w:pStyle w:val="Title"/>');
    expect(xml).toContain("Quarterly plan");
  });
});

/* -------------------------------------------------------------------------- */
/* Node types — all 21, one assertion each                                      */
/* -------------------------------------------------------------------------- */

describe("renderDocx node mapping", () => {
  it("has an assertion below for every type in NOTE_DOCUMENT_NODE_TYPES", () => {
    // The same tripwire `markdown.test.ts` carries, and deliberately a second
    // copy rather than a shared helper: a node type added to the contract must
    // be consciously mapped in BOTH converters, so it should fail in both files
    // and force both to be opened. Without this, a new type would export from
    // DOCX as nothing at all and no suite would notice.
    expect([...NOTE_DOCUMENT_NODE_TYPES]).toStrictEqual([
      "doc",
      "paragraph",
      "heading",
      "text",
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "codeBlock",
      "hardBreak",
      "horizontalRule",
      "pageBreak",
      "taskList",
      "taskItem",
      "table",
      "tableRow",
      "tableHeader",
      "tableCell",
      "mention",
      "image",
      "attachment",
    ]);
  });

  it("doc: emits the document's children into the section body", async () => {
    const xml = await bodyXml(doc(para(text("first")), para(text("second"))));

    expect(xml).toContain("first");
    expect(xml).toContain("second");
  });

  it("paragraph: honours attrs.textAlign", async () => {
    const xml = await bodyXml(
      doc({ type: "paragraph", attrs: { textAlign: "center" }, content: [text("centred")] }),
    );

    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain("centred");
  });

  it("heading: maps a clamped level onto the built-in Word heading styles", async () => {
    const xml = await bodyXml(
      doc(
        { type: "heading", attrs: { level: 3 }, content: [text("three")] },
        // Out-of-range levels clamp rather than producing an invalid style name.
        { type: "heading", attrs: { level: 99 }, content: [text("clamped")] },
      ),
    );

    expect(xml).toContain('<w:pStyle w:val="Heading3"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading6"/>');
  });

  it("text: becomes a run carrying the literal text", async () => {
    const xml = await bodyXml(doc(para(text("plain words"))));

    expect(xml).toContain('<w:t xml:space="preserve">plain words</w:t>');
  });

  it("bulletList / listItem: become bulleted paragraphs whose nesting increments the level", async () => {
    const xml = await bodyXml(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para(text("outer")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [para(text("inner"))] }],
              },
            ],
          },
        ],
      }),
    );

    expect(xml).toContain('<w:ilvl w:val="0"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    expect(xml).toContain("outer");
    expect(xml).toContain("inner");
  });

  it("orderedList: declares a numbering definition and honours attrs.start", async () => {
    const parts = await partsOf(
      doc({
        type: "orderedList",
        attrs: { start: 7 },
        content: [{ type: "listItem", content: [para(text("seventh"))] }],
      }),
    );

    // The paragraph references a numbering definition...
    expect(parts["word/document.xml"]).toContain("<w:numPr>");
    // ...and that definition starts at 7, which is where `attrs.start` survives.
    expect(parts["word/numbering.xml"]).toContain('<w:start w:val="7"/>');
  });

  it("blockquote: falls back to an indented paragraph with a left border", async () => {
    const xml = await bodyXml(doc({ type: "blockquote", content: [para(text("quoted"))] }));

    // Documented fallback: DOCX has no blockquote element.
    expect(xml).toContain("<w:pBdr><w:left ");
    expect(xml).toContain("<w:ind w:left=");
    expect(xml).toContain("quoted");
  });

  it("codeBlock: emits one monospace paragraph per source line and keeps the language", async () => {
    const xml = await bodyXml(
      doc({
        type: "codeBlock",
        // `ts` normalizes to the canonical `typescript`, which is what survives.
        attrs: { language: "ts" },
        content: [text("const a = 1;\nconst b = 2;")],
      }),
    );

    expect(xml).toContain('w:ascii="Courier New"');
    expect(xml).toContain("const a = 1;");
    expect(xml).toContain("const b = 2;");
    // Two source lines never collapse onto one paragraph.
    expect(xml).not.toContain("const a = 1;\nconst b = 2;");
    // Documented fallback: the language survives as a small italic label line.
    expect(xml).toContain(">typescript</w:t>");
  });

  it("codeBlock: omits the label entirely for an unregistered language", async () => {
    const xml = await bodyXml(
      doc({ type: "codeBlock", attrs: { language: "brainfuck" }, content: [text("+++")] }),
    );

    expect(xml).toContain("+++");
    expect(xml).not.toContain("brainfuck");
  });

  it("hardBreak: becomes a run break inside the paragraph", async () => {
    const xml = await bodyXml(doc(para(text("a"), { type: "hardBreak" }, text("b"))));

    expect(xml).toContain("<w:br/>");
  });

  it("horizontalRule: becomes a paragraph with a bottom border", async () => {
    const xml = await bodyXml(doc({ type: "horizontalRule" }));

    expect(xml).toContain("<w:pBdr><w:bottom ");
  });

  it("pageBreak: becomes a REAL page break, the one node DOCX represents natively", async () => {
    const xml = await bodyXml(
      doc(para(text("before")), { type: "pageBreak" }, para(text("after"))),
    );

    expect(xml).toContain('<w:br w:type="page"/>');
  });

  it("taskList / taskItem: become glyph-prefixed indented paragraphs", async () => {
    const xml = await bodyXml(
      doc({
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [para(text("done"))] },
          { type: "taskItem", attrs: { checked: false }, content: [para(text("todo"))] },
          // A missing `checked` reads as unchecked, exactly like `countChecklist`.
          { type: "taskItem", content: [para(text("unknown"))] },
        ],
      }),
    );

    // Documented ceiling: glyphs, not DOCX content controls.
    expect(xml).toContain("☑ ");
    expect(xml).toContain("☐ ");
    expect(xml).toContain("done");
    expect(xml).toContain("todo");
    expect(xml).toContain("unknown");
    // The glyph is the only marker — Word must not also draw a bullet.
    expect(xml).not.toContain("<w:numPr>");
  });

  it("table / tableRow / tableHeader / tableCell: become a real table with a repeating header row", async () => {
    const xml = await bodyXml(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableHeader", content: [para(text("Name"))] }],
          },
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [para(text("Ada"))] }],
          },
        ],
      }),
    );

    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:tr>");
    expect(xml).toContain("<w:tc>");
    // A whole-header row repeats across pages, and header cells are shaded + bold.
    expect(xml).toContain("<w:tblHeader/>");
    expect(xml).toContain('w:fill="E2E8F0"');
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("Name");
    expect(xml).toContain("Ada");
  });

  it("table: preserves colspan and rowspan natively as gridSpan and vMerge", async () => {
    const xml = await bodyXml(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", attrs: { colspan: 3 }, content: [para(text("wide"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", attrs: { rowspan: 2 }, content: [para(text("tall"))] },
              { type: "tableCell", content: [para(text("beside"))] },
            ],
          },
        ],
      }),
    );

    expect(xml).toContain('<w:gridSpan w:val="3"/>');
    expect(xml).toContain("<w:vMerge");
  });

  it("mention: keeps the display label visible AND the stable user id in a bookmark name", async () => {
    const xml = await bodyXml(
      doc(
        para({ type: "mention", attrs: { id: MENTION_ID, label: "Ada Lovelace" } }),
        // A second mention of the same person must not repeat a bookmark name.
        para({ type: "mention", attrs: { id: MENTION_ID, label: "Ada Lovelace" } }),
      ),
    );

    expect(xml).toContain("@Ada Lovelace");
    const flat = MENTION_ID.replace(/-/gu, "");
    expect(xml).toContain(`w:bookmarkStart w:name="mn_${flat}_1"`);
    expect(xml).toContain(`w:bookmarkStart w:name="mn_${flat}_2"`);
  });

  it("mention: degrades a malformed node to plain @label text with no bookmark", async () => {
    const xml = await bodyXml(doc(para({ type: "mention", attrs: { label: "No Id" } })));

    expect(xml).toContain("@No Id");
    expect(xml).not.toContain("w:bookmarkStart");
  });

  it("image: contributes alt text and caption only — never bytes and never a src", async () => {
    const xml = await bodyXml(
      doc({
        type: "image",
        attrs: {
          attachmentId: ATTACHMENT_ID,
          alt: "Revenue by quarter",
          caption: "Fig 1 — revenue",
        },
      }),
    );

    // Documented fallback: alt/caption only. There are no attachment bytes in
    // this converter's inputs; embedding is the `zip` converter's job.
    expect(xml).toContain("Revenue by quarter");
    expect(xml).toContain("Fig 1 — revenue");
    expect(xml).not.toContain("<w:drawing>");
    expect(xml).not.toContain(ATTACHMENT_ID);
  });

  it("attachment: becomes a paragraph naming the file and its human-readable size", async () => {
    const xml = await bodyXml(
      doc({
        type: "attachment",
        attrs: {
          attachmentId: ATTACHMENT_ID,
          name: "deck.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
        },
      }),
    );

    expect(xml).toContain("deck.pdf");
    expect(xml).toContain(formatBinaryBytes(2048));
  });

  it("an unknown, non-contract node type degrades to its text instead of vanishing", async () => {
    const xml = await bodyXml(
      doc({ type: "somethingFromTheFuture", content: [para(text("still here"))] }),
    );

    expect(xml).toContain("still here");
  });
});

/* -------------------------------------------------------------------------- */
/* Mark types — all 10, one assertion each                                      */
/* -------------------------------------------------------------------------- */

describe("renderDocx mark mapping", () => {
  it("bold", async () => {
    expect(await bodyXml(doc(para(text("b", [{ type: "bold" }]))))).toContain("<w:b/>");
  });

  it("italic", async () => {
    expect(await bodyXml(doc(para(text("i", [{ type: "italic" }]))))).toContain("<w:i/>");
  });

  it("strike", async () => {
    expect(await bodyXml(doc(para(text("s", [{ type: "strike" }]))))).toContain("<w:strike/>");
  });

  it("underline: survives natively, unlike in Markdown", async () => {
    expect(await bodyXml(doc(para(text("u", [{ type: "underline" }]))))).toContain(
      '<w:u w:val="single"/>',
    );
  });

  it("code: becomes a monospace, shaded run", async () => {
    const xml = await bodyXml(doc(para(text("c", [{ type: "code" }]))));

    expect(xml).toContain('w:ascii="Courier New"');
    expect(xml).toContain('w:fill="F1F5F9"');
  });

  it("link: becomes a hyperlink through the shared URL sanitizer", async () => {
    const parts = await partsOf(
      doc(para(text("docs", [{ type: "link", attrs: { href: "https://example.com/x" } }]))),
    );

    expect(parts["word/document.xml"]).toContain("<w:hyperlink ");
    // The target itself lives in the relationship part, which is where a reader's
    // Word resolves it from.
    expect(parts["word/_rels/document.xml.rels"]).toContain("https://example.com/x");
  });

  it("link: a refused URL degrades to the plain run rather than a live hyperlink", async () => {
    const parts = await partsOf(
      doc(para(text("gotcha", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))),
    );

    expect(parts["word/document.xml"]).toContain("gotcha");
    expect(parts["word/document.xml"]).not.toContain("<w:hyperlink ");
    expect(parts["word/_rels/document.xml.rels"]).not.toContain("javascript");
  });

  it("textStyle: colour and font size both survive natively — only DOCX can carry them", async () => {
    const xml = await bodyXml(
      doc(para(text("t", [{ type: "textStyle", attrs: { color: "#ff0000", fontSize: "14px" } }]))),
    );

    expect(xml).toContain('<w:color w:val="FF0000"/>');
    // 14px is 10.5pt, i.e. 21 half-points.
    expect(xml).toContain('<w:sz w:val="21"/>');
  });

  it("textStyle: ignores a colour or size the contract would never store", async () => {
    const xml = await bodyXml(
      doc(
        para(
          text("t", [
            { type: "textStyle", attrs: { color: "red; background:url(x)", fontSize: "99999px" } },
          ]),
        ),
      ),
    );

    expect(xml).not.toContain("background");
    expect(xml).not.toContain("<w:color ");
    expect(xml).not.toContain("<w:sz ");
  });

  it("highlight: a named Word highlight with no colour, a shading fill with one", async () => {
    const plain = await bodyXml(doc(para(text("h", [{ type: "highlight" }]))));
    const coloured = await bodyXml(
      doc(para(text("h", [{ type: "highlight", attrs: { color: "#00ff00" } }]))),
    );

    expect(plain).toContain('<w:highlight w:val="yellow"/>');
    expect(coloured).toContain('w:fill="00FF00"');
  });

  it("subscript and superscript", async () => {
    const xml = await bodyXml(
      doc(para(text("x", [{ type: "subscript" }]), text("y", [{ type: "superscript" }]))),
    );

    expect(xml).toContain('<w:vertAlign w:val="subscript"/>');
    expect(xml).toContain('<w:vertAlign w:val="superscript"/>');
  });

  it("an unknown, non-contract mark leaves the text unformatted rather than dropping it", async () => {
    const xml = await bodyXml(doc(para(text("survivor", [{ type: "blink" }]))));

    expect(xml).toContain("survivor");
  });
});

/* -------------------------------------------------------------------------- */
/* Page geometry, header and footer                                             */
/* -------------------------------------------------------------------------- */

describe("renderDocx page setup", () => {
  const expectedSheet = (size: PageSize): { width: number; height: number } => {
    const mm = pageDimensionsMm(size);
    return {
      width: convertMillimetersToTwip(mm.width),
      height: convertMillimetersToTwip(mm.height),
    };
  };

  it.each(["a4", "letter"] as const)("sets the %s sheet size in twips", async (pageSize) => {
    const xml = await bodyXml(doc(para(text("x"))), { pageSize });
    const sheet = expectedSheet(pageSize);

    expect(xml).toContain(`<w:pgSz w:w="${sheet.width}" w:h="${sheet.height}"`);
  });

  it("a4 and letter produce genuinely different sheet dimensions", async () => {
    const a4 = await bodyXml(doc(para(text("x"))), { pageSize: "a4" });
    const letter = await bodyXml(doc(para(text("x"))), { pageSize: "letter" });

    expect(/<w:pgSz[^>]*>/u.exec(a4)?.[0]).not.toBe(/<w:pgSz[^>]*>/u.exec(letter)?.[0]);
  });

  it("uses the documented default margins when the client expressed no preference", async () => {
    const xml = await bodyXml(doc(para(text("x"))));
    const margins = clampMargins({ x: 20, y: 25 });

    expect(xml).toContain(`w:top="${convertMillimetersToTwip(margins.y)}"`);
    expect(xml).toContain(`w:left="${convertMillimetersToTwip(margins.x)}"`);
  });

  it("clamps hostile margins from client storage before they reach the section", async () => {
    const hostile = { x: 9999, y: -5 };
    const xml = await bodyXml(doc(para(text("x"))), {
      options: { ...OPTIONS, margins: hostile },
    });
    const clamped = clampMargins(hostile);

    expect(xml).toContain(`w:left="${convertMillimetersToTwip(clamped.x)}"`);
    expect(xml).toContain(`w:right="${convertMillimetersToTwip(clamped.x)}"`);
    expect(xml).not.toContain(`w:left="${convertMillimetersToTwip(9999)}"`);
    expect(xml).not.toContain('w:left="-');
  });

  it("emits a real header and footer when the options carry them", async () => {
    const parts = await partsOf(doc(para(text("x"))), {
      options: { ...OPTIONS, headerText: "Confidential", footerText: "Page footer" },
    });

    expect(parts["word/document.xml"]).toContain("<w:headerReference");
    expect(parts["word/document.xml"]).toContain("<w:footerReference");
    expect(parts["word/header1.xml"]).toContain("Confidential");
    expect(parts["word/footer1.xml"]).toContain("Page footer");
  });

  it("emits no header or footer part when both options are null", async () => {
    const parts = await partsOf(doc(para(text("x"))));

    expect(parts["word/document.xml"]).not.toContain("<w:headerReference");
    expect(parts["word/document.xml"]).not.toContain("<w:footerReference");
    expect(parts["word/header1.xml"]).toBeUndefined();
    expect(parts["word/footer1.xml"]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Hostile input                                                                */
/* -------------------------------------------------------------------------- */

describe("renderDocx hostile input", () => {
  const nest = (depth: number): unknown =>
    depth === 0
      ? para(text("bottom"))
      : {
          type: "blockquote",
          content: [
            { type: "bulletList", content: [{ type: "listItem", content: [nest(depth - 1)] }] },
          ],
        };

  it("survives nesting far deeper than the document contract admits", async () => {
    // Well past `NOTE_DOCUMENT_LIMITS.maxDepth`: the walk must exhaust its own
    // counter rather than the call stack.
    await expect(bodyXml(doc(nest(400)))).resolves.toContain("<w:body>");
  });

  it("does not emit raw markup for XML metacharacters anywhere they can appear", async () => {
    const hostile = "]]></w:t><w:t>&injected;";
    const xml = await bodyXml(
      doc(
        para(text(hostile)),
        { type: "heading", attrs: { level: 1 }, content: [text(hostile)] },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [para(text(hostile))] }],
            },
          ],
        },
        {
          type: "attachment",
          attrs: {
            attachmentId: ATTACHMENT_ID,
            name: "<script>.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
          },
        },
      ),
      { title: hostile },
    );

    expect(xml).not.toContain(hostile);
    expect(xml).not.toContain("&injected;");
    expect(xml).not.toContain("<script>");
    // Escaped, not dropped: the author's literal text still reaches the reader.
    expect(xml).toContain("&lt;/w:t&gt;");
    expect(xml).toContain("&amp;injected;");
    expect(xml).toContain("&lt;script&gt;.pdf");
  });

  it("survives structurally malformed nodes without throwing or losing the rest", async () => {
    const xml = await bodyXml(
      doc(
        null,
        42,
        { type: "paragraph", content: "not-an-array" },
        { type: "mention", attrs: { id: "not-a-uuid", label: 17 } },
        { type: "image", attrs: { attachmentId: "nope", alt: 5 } },
        { type: "attachment", attrs: {} },
        // A table with nothing usable in it must be skipped, not thrown on:
        // `docx` refuses a table with no rows and a cell with no children.
        { type: "table", content: [] },
        { type: "table", content: [{ type: "tableRow", content: [] }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell" }] }] },
        { type: "codeBlock", attrs: { language: 7 }, content: null },
        { type: "orderedList", attrs: { start: -3 }, content: [{ type: "listItem" }] },
        para(text("survivor")),
      ),
    );

    expect(xml).toContain("survivor");
    expect(xml).not.toContain("not-a-uuid");
  });

  it("bounds a mention label that carries control characters", async () => {
    const label = `Ada${"\u0000\u001b"}Lovelace`;
    const xml = await bodyXml(doc(para({ type: "mention", attrs: { label } })));

    expect(xml).toContain("@Ada  Lovelace");
    expect(xml).not.toContain("\u001b");
  });
});
