import {
  NOTE_DOCUMENT_MARK_TYPES,
  NOTE_DOCUMENT_NODE_TYPES,
  formatBinaryBytes,
} from "@notted/shared-validators";
import { describe, expect, it } from "vitest";

import { EXPORT_FORMAT_MEDIA } from "../export-renderers";

import { documentToMarkdown, renderMarkdown } from "./markdown";

import type { ExportSourceDocument } from "../export-renderers";
import type { ExportOptions } from "@notted/shared-types";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";

const OPTIONS: ExportOptions = {
  includeAttachments: false,
  includeComments: false,
  includeVersionHistory: false,
  headerText: null,
  footerText: null,
  margins: null,
};

function source(overrides: Partial<ExportSourceDocument> = {}): ExportSourceDocument {
  return {
    title: "Note",
    content: doc({ type: "paragraph", content: [text("Hello")] }),
    options: OPTIONS,
    pageSize: "a4",
    subject: {
      workspaceId: "33333333-3333-4333-8333-333333333333",
      noteId: "44444444-4444-4444-8444-444444444444",
      requestedById: USER_ID,
      correlationId: null,
    },
    ...overrides,
  };
}

function doc(...content: unknown[]): unknown {
  return { type: "doc", content };
}

function text(value: string, marks?: unknown[]): unknown {
  return marks === undefined ? { type: "text", text: value } : { type: "text", text: value, marks };
}

function paragraph(...content: unknown[]): unknown {
  return { type: "paragraph", content };
}

/** The body of a one-block document, which is what most assertions here care about. */
function body(...blocks: unknown[]): string {
  return documentToMarkdown(doc(...blocks));
}

/* -------------------------------------------------------------------------- */
/* Every node type in the contract                                             */
/* -------------------------------------------------------------------------- */

describe("documentToMarkdown — nodes", () => {
  it("has an assertion below for every type in NOTE_DOCUMENT_NODE_TYPES", () => {
    // Guards the whole suite: a node type added to the contract without a
    // Markdown mapping fails here rather than silently exporting as nothing.
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

  it("doc — joins its blocks with a blank line", () => {
    expect(body(paragraph(text("one")), paragraph(text("two")))).toBe("one\n\ntwo");
  });

  it("paragraph — renders its inline text", () => {
    expect(body(paragraph(text("plain")))).toBe("plain");
  });

  it("heading — emits one hash per level", () => {
    expect(body({ type: "heading", attrs: { level: 3 }, content: [text("Title")] })).toBe(
      "### Title",
    );
  });

  it("heading — defaults to level 1 and clamps an out-of-range level to 6", () => {
    expect(body({ type: "heading", content: [text("A")] })).toBe("# A");
    expect(body({ type: "heading", attrs: { level: 99 }, content: [text("B")] })).toBe("###### B");
  });

  it("text — escapes the Markdown metacharacters that would change meaning", () => {
    // `#` is NOT escaped: mid-line it is an ordinary character, and escaping it
    // everywhere is what used to turn prose into `paragraph\.`-style noise.
    expect(body(paragraph(text("a*b_c[d]e#f")))).toBe("a\\*b\\_c\\[d\\]e#f");
  });

  it("text — leaves prose punctuation alone", () => {
    expect(body(paragraph(text("Exported body paragraph. See export-fixture.txt (v1.2).")))).toBe(
      "Exported body paragraph. See export-fixture.txt (v1.2).",
    );
  });

  it("paragraph — neutralises a block marker author text put in the first column", () => {
    expect(body(paragraph(text("- not a list")))).toBe("\\- not a list");
    expect(body(paragraph(text("# not a heading")))).toBe("\\# not a heading");
    expect(body(paragraph(text("> not a quote")))).toBe("\\> not a quote");
    expect(body(paragraph(text("1. not an item")))).toBe("1\\. not an item");
    expect(body(paragraph(text("2) not an item")))).toBe("2\\) not an item");
  });

  it("paragraph — escapes the first column only, never a later occurrence", () => {
    expect(body(paragraph(text("a - b # c 1. d")))).toBe("a - b # c 1. d");
  });

  it("bulletList — emits a dash item per child", () => {
    expect(
      body({
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("one"))] },
          { type: "listItem", content: [paragraph(text("two"))] },
        ],
      }),
    ).toBe("- one\n- two");
  });

  it("orderedList — numbers from attrs.start, defaulting to 1", () => {
    const items = [
      { type: "listItem", content: [paragraph(text("a"))] },
      { type: "listItem", content: [paragraph(text("b"))] },
    ];
    expect(body({ type: "orderedList", content: items })).toBe("1. a\n2. b");
    expect(body({ type: "orderedList", attrs: { start: 7 }, content: items })).toBe("7. a\n8. b");
  });

  it("listItem — indents a nested block two spaces so it stays inside the item", () => {
    expect(
      body({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph(text("outer")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph(text("inner"))] }],
              },
            ],
          },
        ],
      }),
    ).toBe("- outer\n\n  - inner");
  });

  it("blockquote — prefixes every produced line, blank ones included", () => {
    const quoted = body({
      type: "blockquote",
      content: [paragraph(text("one")), paragraph(text("two"))],
    });
    expect(quoted).toBe("> one\n>\n> two");
    // A bare blank line would end the quote and orphan everything after it.
    expect(quoted.split("\n").every((line) => line.startsWith(">"))).toBe(true);
  });

  it("codeBlock — fences with the contract's normalized language and never escapes", () => {
    expect(
      body({ type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = *b*;")] }),
    ).toBe("```typescript\nconst a = *b*;\n```");
  });

  it("codeBlock — omits the info string when no language is stored", () => {
    expect(body({ type: "codeBlock", content: [text("plain")] })).toBe("```\nplain\n```");
  });

  it("hardBreak — emits the two-space GFM hard break", () => {
    expect(body(paragraph(text("a"), { type: "hardBreak" }, text("b")))).toBe("a  \nb");
  });

  it("horizontalRule — is a --- block of its own", () => {
    expect(body(paragraph(text("a")), { type: "horizontalRule" })).toBe("a\n\n---");
  });

  it("pageBreak — is an HTML comment, never a bare ---", () => {
    const out = body(paragraph(text("a")), { type: "pageBreak" }, paragraph(text("b")));
    expect(out).toBe("a\n\n<!-- notted:page-break -->\n\nb");
    // THE POINT: `---` on the line after a paragraph is a setext H2 underline,
    // so a `---` page break would silently re-title the preceding paragraph.
    expect(out).not.toContain("\n---");
    expect(out.split("\n")).not.toContain("---");
  });

  it("taskList — renders its items", () => {
    expect(
      body({
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [paragraph(text("todo"))] },
          { type: "taskItem", attrs: { checked: true }, content: [paragraph(text("done"))] },
        ],
      }),
    ).toBe("- [ ] todo\n- [x] done");
  });

  it("taskItem — is unchecked unless attrs.checked is exactly true", () => {
    expect(
      body({ type: "taskItem", attrs: { checked: "true" }, content: [paragraph(text("x"))] }),
    ).toBe("- [ ] x");
    expect(body({ type: "taskItem", content: [paragraph(text("x"))] })).toBe("- [ ] x");
  });

  it("table — treats the first row as the header and emits the GFM delimiter", () => {
    expect(
      body({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph(text("A"))] },
              { type: "tableHeader", content: [paragraph(text("B"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(text("1"))] },
              { type: "tableCell", content: [paragraph(text("2"))] },
            ],
          },
        ],
      }),
    ).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("table — synthesises an empty header row when the first row has no header cell", () => {
    // GFM has no headerless table; dropping the first row into the header slot
    // would lose data, so an empty header is emitted instead.
    expect(
      body({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(text("1"))] },
              { type: "tableCell", content: [paragraph(text("2"))] },
            ],
          },
        ],
      }),
    ).toBe("|  |  |\n| --- | --- |\n| 1 | 2 |");
  });

  it("tableRow — degrades to a single pipe line outside a table", () => {
    expect(
      body({
        type: "tableRow",
        content: [
          { type: "tableCell", content: [paragraph(text("a"))] },
          { type: "tableCell", content: [paragraph(text("b"))] },
        ],
      }),
    ).toBe("| a | b |");
  });

  it("tableHeader — contributes its escaped cell text", () => {
    expect(body({ type: "tableHeader", content: [paragraph(text("Head|er"))] })).toBe("Head\\|er");
  });

  it("tableCell — contributes its escaped cell text", () => {
    expect(body({ type: "tableCell", content: [paragraph(text("cell"))] })).toBe("cell");
  });

  it("mention — keeps the stable user id, not just the display snapshot", () => {
    expect(
      body(paragraph({ type: "mention", attrs: { id: USER_ID, label: "Ada Lovelace" } })),
    ).toBe(`[@Ada Lovelace](notted:user/${USER_ID})`);
  });

  it("image — links the attachment id and puts the caption in italics beneath", () => {
    expect(
      body({
        type: "image",
        attrs: { attachmentId: ATTACHMENT_ID, alt: "A chart", caption: "Figure 1" },
      }),
    ).toBe(`![A chart](notted:attachment/${ATTACHMENT_ID})\n*Figure 1*`);
  });

  it("image — omits the caption line when the author wrote none", () => {
    expect(body({ type: "image", attrs: { attachmentId: ATTACHMENT_ID, alt: "Alt" } })).toBe(
      `![Alt](notted:attachment/${ATTACHMENT_ID})`,
    );
  });

  it("attachment — is a link line carrying the human size", () => {
    expect(
      body({
        type: "attachment",
        attrs: {
          attachmentId: ATTACHMENT_ID,
          name: "deck.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
        },
      }),
    ).toBe(`[deck.pdf](notted:attachment/${ATTACHMENT_ID}) — ${formatBinaryBytes(2048)}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Every mark type in the contract                                             */
/* -------------------------------------------------------------------------- */

describe("documentToMarkdown — marks", () => {
  it("has an assertion below for every type in NOTE_DOCUMENT_MARK_TYPES", () => {
    expect([...NOTE_DOCUMENT_MARK_TYPES]).toStrictEqual([
      "bold",
      "italic",
      "strike",
      "code",
      "underline",
      "link",
      "textStyle",
      "highlight",
      "subscript",
      "superscript",
    ]);
  });

  it.each([
    ["bold", { type: "bold" }, "**x**"],
    ["italic", { type: "italic" }, "*x*"],
    ["strike", { type: "strike" }, "~~x~~"],
    ["code", { type: "code" }, "`x`"],
    ["underline", { type: "underline" }, "<u>x</u>"],
    ["highlight", { type: "highlight", attrs: { color: "#ffff00" } }, "<mark>x</mark>"],
    ["subscript", { type: "subscript" }, "<sub>x</sub>"],
    ["superscript", { type: "superscript" }, "<sup>x</sup>"],
  ])("%s", (_name, mark, expected) => {
    expect(body(paragraph(text("x", [mark])))).toBe(expected);
  });

  it("link — uses the sanitized href", () => {
    expect(
      body(paragraph(text("x", [{ type: "link", attrs: { href: "https://example.com/a" } }]))),
    ).toBe("[x](https://example.com/a)");
  });

  it("textStyle — is dropped, and the text survives", () => {
    // Colour and font size have no Markdown representation at all.
    expect(body(paragraph(text("x", [{ type: "textStyle", attrs: { color: "#ff0000" } }])))).toBe(
      "x",
    );
  });

  it("applies marks innermost-first, matching renderTextWithMarks' ordering", () => {
    // `marks[0]` is the outermost wrapper in the HTML renderer, so it must be
    // the outermost here too or the two exports disagree about nesting.
    expect(body(paragraph(text("x", [{ type: "bold" }, { type: "italic" }])))).toBe("***x***");
  });
});

/* -------------------------------------------------------------------------- */
/* Documented fallbacks                                                        */
/* -------------------------------------------------------------------------- */

describe("documentToMarkdown — fallbacks", () => {
  it("underline, highlight, subscript and superscript fall back to inline HTML", () => {
    const marks = [
      { type: "underline" },
      { type: "highlight" },
      { type: "subscript" },
      { type: "superscript" },
    ];
    const out = body(paragraph(text("x", marks)));
    expect(out).toBe("<u><mark><sub><sup>x</sup></sub></mark></u>");
  });

  it("degrades an unsanitizable link to its text alone", () => {
    const hostile = body(
      paragraph(text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])),
    );
    expect(hostile).toBe("click");
    expect(hostile).not.toContain("javascript:");
    expect(hostile).not.toContain("](");
  });

  it("degrades a malformed mention to plain @label text", () => {
    // No stable UUID: it cannot address a user, so it must not carry a link.
    const out = body(paragraph({ type: "mention", attrs: { id: "not-a-uuid", label: "Ada" } }));
    expect(out).toBe("@Ada");
    expect(out).not.toContain("notted:user/");
  });

  it("drops a mention with nothing readable at all", () => {
    expect(body(paragraph({ type: "mention", attrs: { id: 7 } }))).toBe("");
  });

  it("degrades a malformed image to its alt and caption text", () => {
    expect(body({ type: "image", attrs: { alt: "Alt text", caption: "Caption" } })).toBe(
      "Alt text\nCaption",
    );
  });

  it("degrades a malformed attachment to its name", () => {
    expect(body({ type: "attachment", attrs: { name: "deck.pdf" } })).toBe("deck.pdf");
  });

  it("collapses colspan and rowspan into the first cell without padding", () => {
    // GFM has no span syntax; repeating the cell would duplicate its text and
    // padding with empties would invent cells the author never wrote.
    const out = body({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", attrs: { colspan: 3 }, content: [paragraph(text("Wide"))] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { rowspan: 2 }, content: [paragraph(text("Tall"))] },
            { type: "tableCell", content: [paragraph(text("x"))] },
          ],
        },
      ],
    });
    expect(out).toBe("| Wide |\n| --- |\n| Tall | x |");
    expect(out).not.toContain("colspan");
  });

  it("keeps the text of an unknown, non-contract node instead of dropping it", () => {
    expect(body({ type: "somethingNew", content: [text("survives")] })).toBe("survives");
  });
});

/* -------------------------------------------------------------------------- */
/* Hostile input                                                               */
/* -------------------------------------------------------------------------- */

describe("documentToMarkdown — hostile documents", () => {
  it("fences an inline code span longer than any backtick run it contains", () => {
    const out = body(paragraph(text("a ``` b", [{ type: "code" }])));
    expect(out).toBe("````a ``` b````");
    // Never escaped inside code: the backslashes would be visible characters.
    expect(out).not.toContain("\\");
  });

  it("fences a code block longer than any backtick run it contains", () => {
    expect(body({ type: "codeBlock", content: [text("```\nnested\n```")] })).toBe(
      "````\n```\nnested\n```\n````",
    );
  });

  it("collapses a newline and escapes a pipe inside a table cell", () => {
    const out = body({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [paragraph(text("a|b")), paragraph(text("second line"))],
            },
          ],
        },
      ],
    });
    expect(out).toBe("| a\\|b second line |\n| --- |");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("escapes Markdown metacharacters in an untrusted mention label", () => {
    expect(body(paragraph({ type: "mention", attrs: { id: USER_ID, label: "[Ada](evil)" } }))).toBe(
      // The parentheses stay literal: the link text runs to the first
      // UNESCAPED `]`, which is the one after `(evil)`, so they cannot close
      // the label early or open a destination.
      `[@\\[Ada\\](evil)](notted:user/${USER_ID})`,
    );
  });

  it("terminates on nesting far deeper than the contract allows", () => {
    let node: unknown = paragraph(text("bottom"));
    for (let index = 0; index < 500; index += 1) {
      node = { type: "blockquote", content: [node] };
    }
    const out = documentToMarkdown(doc(node));
    expect(typeof out).toBe("string");
    // The depth cap truncates before the innermost paragraph is reached.
    expect(out).not.toContain("bottom");
  });

  it("never throws on values that are not documents at all", () => {
    for (const value of [null, undefined, 7, "text", [], { type: 5 }]) {
      expect(documentToMarkdown(value)).toBe("");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Artefact assembly                                                           */
/* -------------------------------------------------------------------------- */

describe("renderMarkdown", () => {
  it("carries the shared markdown media facts", () => {
    const artifact = renderMarkdown(source());
    expect(artifact.mimeType).toBe(EXPORT_FORMAT_MEDIA.markdown.mimeType);
    expect(artifact.fileExtension).toBe(EXPORT_FORMAT_MEDIA.markdown.fileExtension);
    expect(Object.isFrozen(artifact)).toBe(true);
  });

  it("assembles header, title, body and footer exactly as renderPlainText does", () => {
    const artifact = renderMarkdown(
      source({
        title: "Meeting Notes",
        options: { ...OPTIONS, headerText: "ACME Confidential", footerText: "Page footer" },
      }),
    );
    expect(artifact.body.toString("utf8")).toBe(
      "ACME Confidential\n\n# Meeting Notes\n\nHello\n\nPage footer\n",
    );
  });

  it("filters out every empty block and still ends in exactly one newline", () => {
    const artifact = renderMarkdown(source({ title: "", content: { type: "doc", content: [] } }));
    expect(artifact.body.toString("utf8")).toBe("\n");
  });

  it("escapes the title so it cannot become other Markdown", () => {
    const artifact = renderMarkdown(source({ title: "# Not a heading [x](y)" }));
    expect(artifact.body.toString("utf8")).toContain("# \\# Not a heading \\[x\\](y)");
  });

  it("ignores source.subject — a .md artefact performs no authorized reads", () => {
    const withSubject = renderMarkdown(source()).body.toString("utf8");
    const other = renderMarkdown(
      source({
        subject: {
          workspaceId: "55555555-5555-4555-8555-555555555555",
          noteId: "66666666-6666-4666-8666-666666666666",
          requestedById: "77777777-7777-4777-8777-777777777777",
          correlationId: "corr-1",
        },
      }),
    ).body.toString("utf8");
    expect(withSubject).toBe(other);
    expect(withSubject).not.toContain("55555555");
  });

  it("renders the same body bytes documentToMarkdown produces, so zip cannot drift", () => {
    const content = doc(paragraph(text("shared")));
    const artifact = renderMarkdown(source({ title: "T", content }));
    expect(artifact.body.toString("utf8")).toBe(`# T\n\n${documentToMarkdown(content)}\n`);
  });
});
