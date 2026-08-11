import { describe, expect, it } from "vitest";

import {
  NOTE_DOCUMENT_ATTACHMENT_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_META_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS,
  NOTE_DOCUMENT_CODE_LANGUAGES,
  NOTE_DOCUMENT_IMAGE_CAPTION_CLASS,
  NOTE_DOCUMENT_IMAGE_CLASS,
  NOTE_DOCUMENT_IMAGE_FIGURE_CLASS,
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_NODE_TYPES,
  NOTE_DOCUMENT_PAGE_BREAK_CLASS,
  NOTE_DOCUMENT_SCHEMA_VERSION,
  NoteDocumentMigrationError,
  countChecklist,
  extractNoteContentPlain,
  migrateNoteDocument,
  noteDocumentAttachmentAttrs,
  noteDocumentImageAttrs,
  noteDocumentSchema,
  normalizeNoteDocumentCodeLanguage,
  renderDocumentHtml,
  resolveNoteImageWrap,
  safeParseNoteDocument,
  sanitizeDocumentUrl,
} from "./document.schema";

const SAFE_LINK_ATTRS = {
  href: "https://example.test/path",
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
} as const;

/** Representative rich fixture covering the configured persisted structures. */
const RICH_DOCUMENT = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1, textAlign: null },
      content: [{ type: "text", text: "Quarterly planning" }],
    },
    {
      type: "paragraph",
      attrs: { textAlign: null },
      content: [
        { type: "text", text: "Alpha prepares a focused launch with measurable outcomes." },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Ship onboarding" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Nested detail" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 1, type: null },
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Draft brief" }] }],
        },
      ],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Publish decision" }] },
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: false },
                  content: [{ type: "paragraph" }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Decisions stay visible." }],
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: null },
      content: [{ type: "text", text: "const safe = true;" }],
    },
    { type: "horizontalRule" },
  ],
} as const;

describe("Part 33 TipTap document contract", () => {
  it("accepts the bounded configured node structure, including the intentionally empty doc", () => {
    expect(noteDocumentSchema.safeParse({ type: "doc", content: [] }).success).toBe(true);
    expect(noteDocumentSchema.safeParse(RICH_DOCUMENT).success).toBe(true);
    expect(extractNoteContentPlain(RICH_DOCUMENT)).toContain("Quarterly planning");
    expect(renderDocumentHtml(RICH_DOCUMENT)).toContain(
      '<li class="task-item" data-checked="true">',
    );
  });

  it("accepts only canonical nullable TipTap defaults and renders no null style values", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: null },
          content: [
            {
              type: "text",
              text: "color",
              marks: [{ type: "textStyle", attrs: { color: "#123456", fontSize: null } }],
            },
            {
              type: "text",
              text: " size",
              marks: [{ type: "textStyle", attrs: { color: null, fontSize: "16px" } }],
            },
            {
              type: "text",
              text: " default",
              marks: [{ type: "highlight", attrs: { color: null } }],
            },
            {
              type: "text",
              text: " colored",
              marks: [{ type: "highlight", attrs: { color: "#abcdef" } }],
            },
            {
              type: "text",
              text: " omitted",
              marks: [{ type: "highlight" }],
            },
            {
              type: "text",
              text: " linked",
              marks: [{ type: "link", attrs: SAFE_LINK_ATTRS }],
            },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2, textAlign: "center" },
        },
        { type: "heading", attrs: { level: 3 } },
        {
          type: "orderedList",
          attrs: { start: 3, type: null },
          content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
        },
        { type: "codeBlock", attrs: { language: null } },
        { type: "codeBlock" },
        {
          type: "orderedList",
          attrs: { start: 4 },
          content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
        },
      ],
    } as const;

    expect(noteDocumentSchema.safeParse(document).success).toBe(true);
    const html = renderDocumentHtml(document);
    expect(html).toContain('<span style="color:#123456">color</span>');
    expect(html).toContain('<span style="font-size:16px"> size</span>');
    expect(html).toContain("<mark> default</mark>");
    expect(html).toContain('<mark style="background-color:#abcdef"> colored</mark>');
    expect(html).toContain("<mark> omitted</mark>");
    expect(html).not.toContain("null");
  });

  it.each([
    ["root text", { type: "doc", content: [{ type: "text", text: "x" }] }],
    [
      "nested paragraph",
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "paragraph" }] }],
      },
    ],
    [
      "empty text",
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
      },
    ],
    [
      "invalid bullet child",
      { type: "doc", content: [{ type: "bulletList", content: [{ type: "paragraph" }] }] },
    ],
    [
      "list item without leading paragraph",
      {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "heading", attrs: { level: 2 } }],
              },
            ],
          },
        ],
      },
    ],
    ["empty blockquote", { type: "doc", content: [{ type: "blockquote", content: [] }] }],
    ["empty task list", { type: "doc", content: [{ type: "taskList", content: [] }] }],
    [
      "marked code block text",
      {
        type: "doc",
        content: [
          {
            type: "codeBlock",
            content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
          },
        ],
      },
    ],
    ["content on a leaf", { type: "doc", content: [{ type: "horizontalRule", content: [] }] }],
    ["marks on a block", { type: "doc", content: [{ type: "paragraph", marks: [] }] }],
    [
      "nonexistent color mark",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "x", marks: [{ type: "color", attrs: { color: "#123456" } }] },
            ],
          },
        ],
      },
    ],
    [
      "duplicate marks",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "bold" }] }],
          },
        ],
      },
    ],
    [
      "code mixed with another mark",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: [{ type: "code" }, { type: "italic" }] }],
          },
        ],
      },
    ],
    [
      "subscript mixed with superscript",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "subscript" }, { type: "superscript" }],
              },
            ],
          },
        ],
      },
    ],
    [
      "arbitrary link defaults",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href: "https://example.test",
                      target: "_self",
                      rel: "opener",
                      class: "tracking",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  ])("rejects structurally invalid content: %s", (_label, value) => {
    expect(noteDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only conservative cross-runtime URL forms", () => {
    expect(sanitizeDocumentUrl("https://x.test/a")).toBe("https://x.test/a");
    expect(sanitizeDocumentUrl("HTTPS://Example.Test/A")).toBe("https://example.test/A");
    expect(sanitizeDocumentUrl("http://[::1]:8080/a")).toBe("http://[::1]:8080/a");
    expect(sanitizeDocumentUrl("http://127.1")).toBe("http://127.0.0.1/");
    expect(sanitizeDocumentUrl("mailto:notes@example.com")).toBe("mailto:notes@example.com");
    expect(sanitizeDocumentUrl("tel:+1 (555) 010-0200")).toBe("tel:+1 (555) 010-0200");
    expect(sanitizeDocumentUrl("  https://x.test/a  ")).toBe("https://x.test/a");
  });

  it.each([
    "https:x.test/no-authority",
    "https://",
    "https://:443/path",
    "https://bad_host.test/path",
    "https://x..test/path",
    "https://x.test:/path",
    "https://x.test:99999/path",
    "https://x.test:notaport/path",
    "https://[::1/path",
    "https://[::1]extra/path",
    "https://%65xample.test/path",
    "https://x.test/%0aheader",
    "https://x.test/%5cadmin",
    "https://x.test\\@evil.test/path",
    "https://user:pass@x.test/path",
    "mailto:user:pass@example.test",
    "mailto://user@example.test",
    "mailto:a@example.test?subject=x",
    "mailto:a@example.test#fragment",
    "mailto:a%0d@example.test",
    "mailto:a@@example.test",
    "tel://+15550100",
    "tel:user@+15550100",
    "tel:+15550100?ext=2",
    "tel:+15550100#fragment",
    "tel:%2b15550100",
    "tel:()1",
    "tel:+1(555",
    "tel:+1)555(",
    "javascript:alert(1)",
    "data:text/html,<b>",
  ])("rejects malformed or deceptive URL %s", (value) => {
    expect(sanitizeDocumentUrl(value)).toBeNull();
  });

  it("accepts TipTap's canonical no-op textStyle defaults and renders them as plain text", () => {
    const document = {
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
    } as const;

    expect(noteDocumentSchema.safeParse(document).success).toBe(true);
    expect(renderDocumentHtml(document)).toBe("<p>plain</p>");
  });

  it("preserves direct, nested, valid-sibling, and unrelated text in source order", () => {
    const historical = {
      type: "doc",
      content: [
        {
          type: "legacySection",
          content: [
            { type: "text", text: "A" },
            { type: "paragraph", content: [{ type: "text", text: "B" }] },
            {
              type: "unknownOuter",
              content: [{ type: "unknownInner", content: [{ type: "text", text: "C" }] }],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "D" }] },
      ],
    } as const;

    const migrated = migrateNoteDocument(historical);
    expect(migrated.migrated).toBe(true);
    expect(migrated.version).toBe(NOTE_DOCUMENT_SCHEMA_VERSION);
    expect(extractNoteContentPlain(migrated.doc)).toBe("ABC\nD");
    expect(noteDocumentSchema.safeParse(migrated.doc).success).toBe(true);
  });

  it("preserves text nested in malformed historical arrays", () => {
    const migrated = migrateNoteDocument({
      type: "doc",
      content: [
        [
          { type: "text", text: "A" },
          [{ type: "legacy", content: [[{ type: "text", text: "B" }]] }],
        ],
        { type: "paragraph", content: [{ type: "text", text: "C" }] },
        [[{ type: "text", text: "D" }]],
      ],
    });

    expect(extractNoteContentPlain(migrated.doc)).toBe("A\nB\nC\nD");
    expect(noteDocumentSchema.safeParse(migrated.doc).success).toBe(true);
  });

  it("repairs invalid placements and strips unsafe attrs without dropping text", () => {
    const historical = {
      type: "doc",
      content: [
        { type: "text", text: "root" },
        {
          type: "paragraph",
          attrs: { onclick: "alert(1)" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "item" }],
            },
          ],
        },
        {
          type: "codeBlock",
          content: [
            { type: "text", text: "code", marks: [{ type: "bold" }] },
            { type: "paragraph", content: [{ type: "text", text: " child" }] },
          ],
        },
      ],
    } as const;

    const migrated = migrateNoteDocument(historical);
    expect(noteDocumentSchema.safeParse(migrated.doc).success).toBe(true);
    expect(extractNoteContentPlain(migrated.doc).replaceAll("\n", "")).toBe(
      "rootnesteditemcode child",
    );
  });

  it("normalizes legacy color marks and canonicalizes supported mark defaults", () => {
    const migrated = migrateNoteDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "legacy",
              marks: [
                { type: "color", attrs: { color: "#112233" } },
                { type: "link", attrs: { href: "https://example.test/path" } },
                { type: "highlight" },
              ],
            },
          ],
        },
      ],
    });

    expect(migrated.doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "legacy",
              marks: [
                { type: "textStyle", attrs: { color: "#112233", fontSize: null } },
                { type: "link", attrs: SAFE_LINK_ATTRS },
                { type: "highlight", attrs: { color: null } },
              ],
            },
          ],
        },
      ],
    });
    expect(noteDocumentSchema.safeParse(migrated.doc).success).toBe(true);
  });

  it("fails explicitly rather than truncating over-limit historical input", () => {
    const oversized = {
      type: "doc",
      content: [
        {
          type: "legacy",
          content: [{ type: "text", text: "x".repeat(NOTE_DOCUMENT_LIMITS.maxString + 1) }],
        },
      ],
    };
    expect(() => migrateNoteDocument(oversized)).toThrow(NoteDocumentMigrationError);
    expect(() => migrateNoteDocument(oversized)).toThrow(/oversized text node/);
  });

  it("leaves clean v1 input unchanged and post-validates every successful migration", () => {
    const clean = migrateNoteDocument(RICH_DOCUMENT);
    expect(clean.migrated).toBe(false);
    expect(clean.doc).toBe(RICH_DOCUMENT);

    const recovered = [
      migrateNoteDocument({ type: "note", content: [{ type: "text", text: "one" }] }),
      migrateNoteDocument({ type: "doc", content: [{ type: "unknown", text: "two" }] }),
      migrateNoteDocument({ type: "doc", content: [{ type: "bulletList", content: [] }] }),
    ];
    for (const result of recovered) {
      expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    }
  });

  it("collects independently reachable validation issues", () => {
    const result = safeParseNoteDocument({
      type: "doc",
      content: [
        { type: "image" },
        { type: "paragraph", attrs: { unknown: 1 } },
        { type: "paragraph", content: [{ type: "text", text: "" }] },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

const CELL_ATTRS = { colspan: 1, rowspan: 1, colwidth: null } as const;

function cell(text: string, attrs: Record<string, unknown> = CELL_ATTRS) {
  return {
    type: "tableCell",
    attrs,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function header(text: string, attrs: Record<string, unknown> = CELL_ATTRS) {
  return {
    type: "tableHeader",
    attrs,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function tableDocument(rows: readonly unknown[]) {
  return { type: "doc", content: [{ type: "table", content: rows }] };
}

describe("Part 35 table contract", () => {
  it("accepts the structure TipTap's table extensions actually emit", () => {
    const document = tableDocument([
      { type: "tableRow", content: [header("Metric"), header("Value")] },
      {
        type: "tableRow",
        content: [cell("Revenue"), cell("42", { colspan: 2, rowspan: 1, colwidth: [180] })],
      },
    ]);
    expect(noteDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("accepts block content, fractional widths, and prosemirror's zero placeholders", () => {
    const document = tableDocument([
      {
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            attrs: { colspan: 2, rowspan: 2, colwidth: [120.5, 0] },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "intro" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "detail" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(safeParseNoteDocument(document).success).toBe(true);
  });

  it.each([
    [
      "zero colspan",
      tableDocument([
        { type: "tableRow", content: [cell("a", { colspan: 0, rowspan: 1, colwidth: null })] },
      ]),
    ],
    [
      "fractional colspan",
      tableDocument([
        { type: "tableRow", content: [cell("a", { colspan: 1.5, rowspan: 1, colwidth: null })] },
      ]),
    ],
    [
      "oversized rowspan",
      tableDocument([
        {
          type: "tableRow",
          content: [
            cell("a", {
              colspan: 1,
              rowspan: NOTE_DOCUMENT_LIMITS.maxTableCellSpan + 1,
              colwidth: null,
            }),
          ],
        },
      ]),
    ],
    [
      "missing cell attrs",
      tableDocument([
        { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] },
      ]),
    ],
    [
      "unknown cell attr",
      tableDocument([
        { type: "tableRow", content: [cell("a", { ...CELL_ATTRS, background: "#fff" })] },
      ]),
    ],
    [
      "negative column width",
      tableDocument([
        { type: "tableRow", content: [cell("a", { colspan: 1, rowspan: 1, colwidth: [-10] })] },
      ]),
    ],
    [
      "oversized column width",
      tableDocument([
        {
          type: "tableRow",
          content: [
            cell("a", {
              colspan: 1,
              rowspan: 1,
              colwidth: [NOTE_DOCUMENT_LIMITS.maxTableColumnWidth + 1],
            }),
          ],
        },
      ]),
    ],
    [
      "non-numeric column width",
      tableDocument([
        { type: "tableRow", content: [cell("a", { colspan: 1, rowspan: 1, colwidth: ["120"] })] },
      ]),
    ],
    ["empty table", tableDocument([])],
    ["row outside a table", { type: "doc", content: [{ type: "tableRow", content: [cell("a")] }] }],
    [
      "non-cell child of a row",
      tableDocument([{ type: "tableRow", content: [{ type: "paragraph" }] }]),
    ],
    ["paragraph child of table", tableDocument([{ type: "paragraph" }])],
    ["empty row", tableDocument([{ type: "tableRow", content: [] }])],
    [
      "inline content in a cell",
      tableDocument([
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: CELL_ATTRS, content: [{ type: "text", text: "x" }] },
          ],
        },
      ]),
    ],
    [
      "empty cell",
      tableDocument([
        { type: "tableRow", content: [{ type: "tableCell", attrs: CELL_ATTRS, content: [] }] },
      ]),
    ],
  ])("rejects a malformed table: %s", (_label, document) => {
    expect(safeParseNoteDocument(document).success).toBe(false);
  });

  it("rejects tables beyond the explicit row, column, and total-cell bounds", () => {
    const wideRow = {
      type: "tableRow",
      content: Array.from({ length: NOTE_DOCUMENT_LIMITS.maxTableColumns + 1 }, () => cell("x")),
    };
    expect(safeParseNoteDocument(tableDocument([wideRow])).success).toBe(false);

    const tallTable = tableDocument(
      Array.from({ length: NOTE_DOCUMENT_LIMITS.maxTableRows + 1 }, () => ({
        type: "tableRow",
        content: [cell("x")],
      })),
    );
    expect(safeParseNoteDocument(tallTable).success).toBe(false);

    const rowOfTen = {
      type: "tableRow",
      content: Array.from({ length: 10 }, () => cell("x")),
    };
    const tooManyCells = tableDocument(
      Array.from({ length: NOTE_DOCUMENT_LIMITS.maxTableCells / 10 + 1 }, () => rowOfTen),
    );
    const errors = safeParseNoteDocument(tooManyCells);
    expect(errors.success).toBe(false);
    expect(errors.success ? [] : errors.errors).toContain("Document has too many table cells");
  });

  it("renders escaped table HTML with only the reviewed attributes", () => {
    const html = renderDocumentHtml(
      tableDocument([
        { type: "tableRow", content: [header("<b>Metric</b>")] },
        {
          type: "tableRow",
          content: [cell("a & b", { colspan: 2, rowspan: 3, colwidth: [100, 80] })],
        },
        { type: "tableRow", content: [cell("plain")] },
      ]),
    );

    expect(html).toContain("<table><tbody>");
    expect(html).toContain("<th><p>&lt;b&gt;Metric&lt;/b&gt;</p></th>");
    expect(html).toContain('<td colspan="2" rowspan="3" style="width:180px"><p>a &amp; b</p></td>');
    expect(html).toContain("<td><p>plain</p></td>");
    expect(html).not.toContain("colwidth");
    expect(html).not.toContain("<script");
  });

  it("extracts one readable line per table row", () => {
    const plain = extractNoteContentPlain(
      tableDocument([
        { type: "tableRow", content: [header("Metric"), header("Value")] },
        { type: "tableRow", content: [cell("Revenue"), cell("42")] },
      ]),
    );
    expect(plain).toBe("Metric\tValue\nRevenue\t42");
  });

  it("recovers historical table-like structures without losing text", () => {
    const result = migrateNoteDocument({
      type: "doc",
      content: [
        {
          type: "table",
          attrs: { legacy: true },
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: "2" },
                  content: [{ type: "text", text: "Head" }],
                },
                { type: "paragraph", content: [{ type: "text", text: "Loose" }] },
              ],
            },
          ],
        },
      ],
    });

    expect(result.migrated).toBe(true);
    expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    expect(extractNoteContentPlain(result.doc)).toContain("Head");
    expect(extractNoteContentPlain(result.doc)).toContain("Loose");
  });

  it("keeps recoverable text when a table cannot be represented as a table", () => {
    const result = migrateNoteDocument({
      type: "doc",
      content: [
        { type: "table", content: [{ type: "tableRow" }] },
        {
          type: "tableCell",
          content: [{ type: "paragraph", content: [{ type: "text", text: "orphan" }] }],
        },
      ],
    });
    expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    expect(extractNoteContentPlain(result.doc)).toContain("orphan");
  });

  it("does not change the contract version for the additive table widening", () => {
    expect(NOTE_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(noteDocumentSchema.safeParse(RICH_DOCUMENT).success).toBe(true);
  });
});

describe("Part 35 code block language registry", () => {
  it("accepts every registered language and rejects anything else", () => {
    for (const language of NOTE_DOCUMENT_CODE_LANGUAGES) {
      expect(
        safeParseNoteDocument({
          type: "doc",
          content: [{ type: "codeBlock", attrs: { language } }],
        }).success,
      ).toBe(true);
    }
    for (const language of ["ts", "cobol", "LANGUAGE-INJECTION", "", "javascript "]) {
      expect(
        safeParseNoteDocument({
          type: "doc",
          content: [{ type: "codeBlock", attrs: { language } }],
        }).success,
      ).toBe(false);
    }
  });

  it("normalizes aliases and refuses unknown or unbounded values", () => {
    expect(normalizeNoteDocumentCodeLanguage("ts")).toBe("typescript");
    expect(normalizeNoteDocumentCodeLanguage("TSX")).toBe("typescript");
    expect(normalizeNoteDocumentCodeLanguage(" html ")).toBe("xml");
    expect(normalizeNoteDocumentCodeLanguage("yaml")).toBe("yaml");
    expect(normalizeNoteDocumentCodeLanguage("cobol")).toBeNull();
    expect(normalizeNoteDocumentCodeLanguage(null)).toBeNull();
    expect(normalizeNoteDocumentCodeLanguage(42)).toBeNull();
    expect(normalizeNoteDocumentCodeLanguage("x".repeat(500))).toBeNull();
  });

  it("migrates an out-of-registry language to a normalized value", () => {
    const aliased = migrateNoteDocument({
      type: "doc",
      content: [
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
      ],
    });
    expect(aliased.migrated).toBe(true);
    expect(aliased.doc).toMatchObject({
      content: [{ type: "codeBlock", attrs: { language: "typescript" } }],
    });

    const unknown = migrateNoteDocument({
      type: "doc",
      content: [
        { type: "codeBlock", attrs: { language: "cobol" }, content: [{ type: "text", text: "x" }] },
      ],
    });
    expect(unknown.doc).toMatchObject({
      content: [{ type: "codeBlock", attrs: { language: null } }],
    });
    expect(extractNoteContentPlain(unknown.doc)).toBe("x");
  });
});

const MENTION_USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const OTHER_USER_ID = "1f0c3b52-6ad6-4a10-9c4e-4ce0d19f2f11";

function mention(attrs: Record<string, unknown>) {
  return { type: "mention", attrs };
}

function mentionDocument(attrs: Record<string, unknown>, leading = "Hello ") {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: null },
        content: [{ type: "text", text: leading }, mention(attrs)],
      },
    ],
  };
}

describe("Part 36 mention contract", () => {
  it("accepts the structure the mention extension actually emits", () => {
    const document = mentionDocument({ id: MENTION_USER_ID, label: "Ada Lovelace" });
    expect(noteDocumentSchema.safeParse(document).success).toBe(true);
    // Round-tripping the accepted value must not change it.
    const parsed = safeParseNoteDocument(document);
    expect(parsed.success ? parsed.doc : null).toEqual(document);
  });

  it("accepts a mention in every inline position the contract allows", () => {
    const inline = [mention({ id: MENTION_USER_ID, label: "Ada" })];
    expect(
      noteDocumentSchema.safeParse({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2, textAlign: null }, content: inline },
          { type: "paragraph", attrs: { textAlign: null }, content: inline },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", attrs: { textAlign: null }, content: inline }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a non-UUID id", { id: "ada", label: "Ada" }],
    ["a numeric id", { id: 7, label: "Ada" }],
    ["a null id", { id: null, label: "Ada" }],
    ["a missing id", { label: "Ada" }],
    ["a missing label", { id: MENTION_USER_ID }],
    ["an empty label", { id: MENTION_USER_ID, label: "" }],
    ["a null label", { id: MENTION_USER_ID, label: null }],
    [
      "an oversized label",
      { id: MENTION_USER_ID, label: "x".repeat(NOTE_DOCUMENT_LIMITS.maxMentionLabel + 1) },
    ],
    ["a control character in the label", { id: MENTION_USER_ID, label: "Ada\nLovelace" }],
    ["an extra attribute", { id: MENTION_USER_ID, label: "Ada", href: "https://example.test" }],
    ["a workspace attribute", { id: MENTION_USER_ID, label: "Ada", workspaceId: OTHER_USER_ID }],
  ])("rejects a mention with %s", (_label, attrs) => {
    expect(safeParseNoteDocument(mentionDocument(attrs)).success).toBe(false);
  });

  it("rejects a mention that carries content, marks, or no attributes at all", () => {
    const base = { id: MENTION_USER_ID, label: "Ada" };
    const withContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: base, content: [{ type: "text", text: "x" }] }],
        },
      ],
    };
    const withMarks = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: base, marks: [{ type: "bold" }] }],
        },
      ],
    };
    const withoutAttrs = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention" }] }],
    };

    expect(safeParseNoteDocument(withContent).success).toBe(false);
    expect(safeParseNoteDocument(withMarks).success).toBe(false);
    expect(safeParseNoteDocument(withoutAttrs).success).toBe(false);
  });

  it("rejects a mention in block position", () => {
    expect(
      safeParseNoteDocument({
        type: "doc",
        content: [mention({ id: MENTION_USER_ID, label: "Ada" })],
      }).success,
    ).toBe(false);
    expect(
      safeParseNoteDocument({
        type: "doc",
        content: [
          {
            type: "codeBlock",
            attrs: { language: null },
            content: [mention({ id: MENTION_USER_ID, label: "Ada" })],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a document beyond the explicit mention bound", () => {
    const one = mention({ id: MENTION_USER_ID, label: "Ada" });
    const paragraphs = Array.from({ length: NOTE_DOCUMENT_LIMITS.maxMentions / 100 + 1 }, () => ({
      type: "paragraph",
      content: Array.from({ length: 100 }, () => one),
    }));
    const result = safeParseNoteDocument({ type: "doc", content: paragraphs });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.errors).toContain("Document has too many mentions");
  });

  it("renders a mention as an escaped span with only the reviewed attributes", () => {
    const html = renderDocumentHtml(
      mentionDocument({
        id: MENTION_USER_ID,
        label: `<script>alert("x&y")</script> 'Ada'`,
      }),
    );

    expect(html).toContain(`<span class="notted-mention" data-mention-id="${MENTION_USER_ID}">`);
    expect(html).toContain(
      "@&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt; &#39;Ada&#39;",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("data-label");
  });

  it("renders an unusable historical mention as escaped text instead of dropping it", () => {
    const html = renderDocumentHtml({
      type: "doc",
      content: [{ type: "paragraph", content: [mention({ id: "ada", label: "<b>Ada</b>" })] }],
    });
    expect(html).toBe("<p>@&lt;b&gt;Ada&lt;/b&gt;</p>");
  });

  it("extracts a mention as readable @label text", () => {
    expect(
      extractNoteContentPlain(mentionDocument({ id: MENTION_USER_ID, label: "Ada Lovelace" })),
    ).toBe("Hello @Ada Lovelace");
  });

  it("migrates a malformed mention to recoverable text without losing the name", () => {
    const result = migrateNoteDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "cc " },
            { type: "mention", attrs: { id: "legacy-42", label: "Ada Lovelace", role: "owner" } },
          ],
        },
      ],
    });

    expect(result.migrated).toBe(true);
    expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    expect(extractNoteContentPlain(result.doc)).toBe("cc @Ada Lovelace");
  });

  it("keeps a valid mention as a mention while repairing the block around it", () => {
    const result = migrateNoteDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "middle" },
          content: [
            { type: "mention", attrs: { id: MENTION_USER_ID, label: "Ada", extra: "drop me" } },
          ],
        },
      ],
    });

    expect(result.migrated).toBe(true);
    expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    expect(result.doc).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: MENTION_USER_ID, label: "Ada" } }],
        },
      ],
    });
  });

  it("degrades a mention nested in an unrepresentable historical node to its name", () => {
    const result = migrateNoteDocument({
      type: "doc",
      content: [
        {
          type: "legacyCallout",
          content: [{ type: "mention", attrs: { id: MENTION_USER_ID, label: "Ada" } }],
        },
      ],
    });

    expect(result.migrated).toBe(true);
    expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    // The node type cannot be represented, so the mention becomes readable text
    // rather than disappearing along with the block that held it.
    expect(extractNoteContentPlain(result.doc)).toBe("@Ada");
  });

  it("promotes a block-position mention into a paragraph rather than dropping it", () => {
    const result = migrateNoteDocument({
      type: "doc",
      content: [{ type: "mention", attrs: { id: MENTION_USER_ID, label: "Ada" } }],
    });
    expect(noteDocumentSchema.safeParse(result.doc).success).toBe(true);
    expect(extractNoteContentPlain(result.doc)).toBe("@Ada");
  });

  it("does not change the contract version for the additive mention widening", () => {
    expect(NOTE_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(noteDocumentSchema.safeParse(RICH_DOCUMENT).success).toBe(true);
  });
});

describe("Part 38 page break contract", () => {
  const pageBreakDocument = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Cover page" }] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "Appendix" }] },
    ],
  } as const;

  it("accepts an attribute-free page break as a block node and round-trips it unchanged", () => {
    const parsed = safeParseNoteDocument(pageBreakDocument);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.doc).toEqual(pageBreakDocument);
    expect(noteDocumentSchema.safeParse(parsed.doc).success).toBe(true);
  });

  it("accepts a page break nested wherever a block node is allowed", () => {
    expect(
      safeParseNoteDocument({
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [{ type: "paragraph" }, { type: "pageBreak" }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["children", { type: "doc", content: [{ type: "pageBreak", content: [] }] }],
    [
      "text children",
      {
        type: "doc",
        content: [{ type: "pageBreak", content: [{ type: "text", text: "x" }] }],
      },
    ],
    ["attributes", { type: "doc", content: [{ type: "pageBreak", attrs: { after: 2 } }] }],
    ["marks", { type: "doc", content: [{ type: "pageBreak", marks: [{ type: "bold" }] }] }],
    ["stray fields", { type: "doc", content: [{ type: "pageBreak", text: "x" }] }],
  ])("rejects a page break carrying %s", (_label, document) => {
    expect(safeParseNoteDocument(document).success).toBe(false);
  });

  it("renders the one class print.css and the Part 63 export template key off", () => {
    expect(NOTE_DOCUMENT_PAGE_BREAK_CLASS).toBe("notted-page-break");
    expect(renderDocumentHtml(pageBreakDocument)).toBe(
      `<p>Cover page</p><div class="${NOTE_DOCUMENT_PAGE_BREAK_CLASS}"></div><p>Appendix</p>`,
    );
    // A `div`, never an `hr`: `break-after: page` on a block box is unambiguous
    // and the node carries no separator semantic.
    expect(renderDocumentHtml(pageBreakDocument)).not.toContain("<hr>");
  });

  it("contributes nothing to the plain-text projection, exactly like a horizontal rule", () => {
    const rule = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Cover page" }] },
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "Appendix" }] },
      ],
    };
    expect(extractNoteContentPlain(pageBreakDocument)).toBe("Cover page\nAppendix");
    expect(extractNoteContentPlain(pageBreakDocument)).toBe(extractNoteContentPlain(rule));
  });

  it("survives migration untouched and recovers a malformed historical break", () => {
    const clean = migrateNoteDocument(pageBreakDocument);
    expect(clean.migrated).toBe(false);
    expect(clean.doc).toEqual(pageBreakDocument);

    const recovered = migrateNoteDocument({
      type: "doc",
      content: [{ type: "pageBreak", attrs: { legacy: true }, content: [] }],
    });
    expect(recovered.migrated).toBe(true);
    expect(recovered.doc).toEqual({ type: "doc", content: [{ type: "pageBreak" }] });
    expect(noteDocumentSchema.safeParse(recovered.doc).success).toBe(true);
  });

  it("does not change the contract version for the additive page-break widening", () => {
    expect(NOTE_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(NOTE_DOCUMENT_NODE_TYPES).toContain("pageBreak");
  });
});

describe("Part 42 image contract", () => {
  const ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";

  const imageNode = (attrs: Record<string, unknown> = {}) => ({
    type: "image",
    attrs: { attachmentId: ATTACHMENT_ID, alt: "A chart", width: 800, height: 600, ...attrs },
  });

  const imageDocument = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      imageNode(),
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ],
  };

  it("accepts an image as a block node and round-trips it unchanged", () => {
    const parsed = safeParseNoteDocument(imageDocument);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.doc).toEqual(imageDocument);
    expect(noteDocumentSchema.safeParse(parsed.doc).success).toBe(true);
  });

  it("accepts an image wherever a block node is allowed", () => {
    for (const wrapper of [
      { type: "doc", content: [{ type: "blockquote", content: [imageNode()] }] },
      {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph" }, imageNode()] }],
          },
        ],
      },
      {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [imageNode()],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]) {
      expect(safeParseNoteDocument(wrapper).success).toBe(true);
    }
  });

  it("rejects an image in inline position, because it is a block node", () => {
    expect(
      safeParseNoteDocument({
        type: "doc",
        content: [{ type: "paragraph", content: [imageNode()] }],
      }).success,
    ).toBe(false);
  });

  it("accepts an empty alt, which is how a decorative image is marked", () => {
    expect(safeParseNoteDocument({ type: "doc", content: [imageNode({ alt: "" })] }).success).toBe(
      true,
    );
  });

  it("accepts null intrinsic dimensions, which are only a layout hint", () => {
    expect(
      safeParseNoteDocument({ type: "doc", content: [imageNode({ width: null, height: null })] })
        .success,
    ).toBe(true);
  });

  /**
   * The load-bearing test for the Part 42 criterion "the saved document never
   * relies on temporary blob or base64 URLs". It is not a style check: the
   * contract has NO attribute that could hold a URL, so every one of these is
   * rejected by `NODE_ALLOWED_ATTRS`'s loop rather than by a special case.
   */
  it.each(["src", "url", "previewUrl", "dataUri", "href", "srcset", "blurDataUri"])(
    "rejects an image carrying a %s attribute, so no blob: or data: URL can ever be persisted",
    (attribute) => {
      const blob = { type: "doc", content: [imageNode({ [attribute]: "blob:http://x/abc" })] };
      const base64 = {
        type: "doc",
        content: [imageNode({ [attribute]: "data:image/webp;base64,AAAA" })],
      };
      const blobResult = safeParseNoteDocument(blob);
      expect(blobResult.success).toBe(false);
      if (!blobResult.success) {
        expect(blobResult.errors.join("; ")).toContain(`not allowed on image: ${attribute}`);
      }
      expect(safeParseNoteDocument(base64).success).toBe(false);
    },
  );

  it.each([
    ["a missing attachmentId", imageNode({ attachmentId: undefined })],
    ["a non-UUID attachmentId", imageNode({ attachmentId: "../../etc/passwd" })],
    ["a missing alt", imageNode({ alt: undefined })],
    ["a null alt", imageNode({ alt: null })],
    ["control characters in alt", imageNode({ alt: "line\u0000break" })],
    ["an oversized alt", imageNode({ alt: "a".repeat(NOTE_DOCUMENT_LIMITS.maxImageAlt + 1) })],
    ["a zero width", imageNode({ width: 0 })],
    ["a fractional height", imageNode({ height: 12.5 })],
    ["a negative width", imageNode({ width: -1 })],
    ["an oversized dimension", imageNode({ width: NOTE_DOCUMENT_LIMITS.maxImageDimension + 1 })],
    ["children", { ...imageNode(), content: [{ type: "paragraph" }] }],
    ["marks", { ...imageNode(), marks: [{ type: "link", attrs: SAFE_LINK_ATTRS }] }],
    ["stray fields", { ...imageNode(), text: "x" }],
  ])("rejects an image with %s", (_label, node) => {
    expect(safeParseNoteDocument({ type: "doc", content: [node] }).success).toBe(false);
  });

  it("rejects a node with no attrs at all", () => {
    expect(safeParseNoteDocument({ type: "doc", content: [{ type: "image" }] }).success).toBe(
      false,
    );
  });

  it("bounds how many images one note may reference", () => {
    const atLimit = {
      type: "doc",
      content: Array.from({ length: NOTE_DOCUMENT_LIMITS.maxImages }, () => imageNode()),
    };
    const overLimit = {
      type: "doc",
      content: Array.from({ length: NOTE_DOCUMENT_LIMITS.maxImages + 1 }, () => imageNode()),
    };
    expect(safeParseNoteDocument(atLimit).success).toBe(true);
    const rejected = safeParseNoteDocument(overLimit);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.errors).toContain("Document has too many images");
  });

  it("renders a figure with the contract classes and no src of any kind", () => {
    expect(NOTE_DOCUMENT_IMAGE_CLASS).toBe("notted-image");
    expect(NOTE_DOCUMENT_IMAGE_FIGURE_CLASS).toBe("notted-image-figure");
    const html = renderDocumentHtml(imageDocument);
    expect(html).toBe(
      `<p>Before</p><figure class="${NOTE_DOCUMENT_IMAGE_FIGURE_CLASS}" data-align="center" ` +
        `data-wrap="block" data-full-width="false">` +
        `<img class="${NOTE_DOCUMENT_IMAGE_CLASS}" ` +
        `data-attachment-id="${ATTACHMENT_ID}" alt="A chart" loading="lazy" decoding="async">` +
        "</figure><p>After</p>",
    );
    // Part 63's export pipeline substitutes the source; this module has no
    // workspace id and no authorization context, so it never invents one.
    expect(html).not.toContain("src=");
    expect(html).not.toContain("blob:");
    expect(html).not.toContain("data:");
  });

  it("escapes alt text rather than trusting it", () => {
    const html = renderDocumentHtml({
      type: "doc",
      content: [imageNode({ alt: '"><script>alert(1)</script>' })],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("contributes alt text to the plain-text projection, and nothing when decorative", () => {
    expect(extractNoteContentPlain(imageDocument)).toBe("Before\nA chart\nAfter");
    expect(
      extractNoteContentPlain({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Before" }] },
          imageNode({ alt: "" }),
          { type: "paragraph", content: [{ type: "text", text: "After" }] },
        ],
      }),
    ).toBe("Before\nAfter");
  });

  it("survives migration untouched", () => {
    const clean = migrateNoteDocument(imageDocument);
    expect(clean.migrated).toBe(false);
    expect(clean.doc).toEqual(imageDocument);
  });

  it("strips a historical src during recovery instead of losing the image", () => {
    const recovered = migrateNoteDocument({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            attachmentId: ATTACHMENT_ID,
            src: "blob:http://localhost:3000/9d1f",
            alt: "Recovered",
            width: 100,
            height: 50,
          },
        },
      ],
    });
    expect(recovered.migrated).toBe(true);
    expect(recovered.doc).toEqual({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            attachmentId: ATTACHMENT_ID,
            alt: "Recovered",
            width: 100,
            height: 50,
            // Recovery re-emits CANONICAL attributes, so a node written before
            // Part 43 gains the documented defaults rather than a partial set.
            align: "center",
            wrap: "block",
            fullWidth: false,
            caption: "",
          },
        },
      ],
    });
    expect(JSON.stringify(recovered.doc)).not.toContain("blob:");
  });

  it("degrades an image with no usable attachment id to its alt text", () => {
    const recovered = migrateNoteDocument({
      type: "doc",
      content: [{ type: "image", attrs: { src: "data:image/png;base64,AAA", alt: "Lost chart" } }],
    });
    expect(recovered.migrated).toBe(true);
    expect(recovered.doc).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Lost chart" }] }],
    });
  });

  it("moves an inline image into block position rather than dropping it", () => {
    const recovered = migrateNoteDocument({
      type: "doc",
      content: [{ type: "paragraph", content: [imageNode({ alt: "Inline" })] }],
    });
    expect(recovered.migrated).toBe(true);
    expect(extractNoteContentPlain(recovered.doc)).toContain("Inline");
    expect(noteDocumentSchema.safeParse(recovered.doc).success).toBe(true);
  });

  it("exposes the reviewed attribute accessor used by the editor node view", () => {
    expect(noteDocumentImageAttrs(imageNode().attrs)).toEqual({
      attachmentId: ATTACHMENT_ID,
      alt: "A chart",
      width: 800,
      height: 600,
      align: "center",
      wrap: "block",
      fullWidth: false,
      caption: "",
    });
    expect(noteDocumentImageAttrs({ attachmentId: "nope", alt: "" })).toBeNull();
    // Absent layout attributes are the Part 42 shape, and they read as the
    // documented defaults — which is why no migration was needed.
    expect(noteDocumentImageAttrs({ attachmentId: ATTACHMENT_ID, alt: "x" })).toEqual({
      attachmentId: ATTACHMENT_ID,
      alt: "x",
      width: null,
      height: null,
      align: "center",
      wrap: "block",
      fullWidth: false,
      caption: "",
    });
  });

  it("does not change the contract version for the additive image widening", () => {
    // Additive and forward-only: every stored v1 document is still valid v1, so
    // there is nothing to migrate and no persisted version to compare against.
    // The first incompatible change bumps this and adds the column plus backfill.
    expect(NOTE_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(NOTE_DOCUMENT_NODE_TYPES).toContain("image");
  });
});

describe("Part 43 image manipulation contract", () => {
  const ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";

  const imageNode = (attrs: Record<string, unknown> = {}) => ({
    type: "image",
    attrs: {
      attachmentId: ATTACHMENT_ID,
      alt: "A chart",
      width: 800,
      height: 600,
      align: "center",
      wrap: "block",
      fullWidth: false,
      caption: "",
      ...attrs,
    },
  });

  const imageDoc = (attrs: Record<string, unknown> = {}) => ({
    type: "doc",
    content: [imageNode(attrs)],
  });

  it("round-trips every layout attribute unchanged", () => {
    const input = imageDoc({
      align: "right",
      wrap: "inline",
      fullWidth: false,
      caption: "Figure 1 - quarterly revenue",
      width: 320,
      height: 240,
    });
    const parsed = safeParseNoteDocument(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.doc).toEqual(input);
    expect(noteDocumentSchema.safeParse(parsed.doc).success).toBe(true);
  });

  it("accepts a Part 42 document that has none of them", () => {
    // The compatibility guarantee that made this widening additive: an absent
    // attribute is the documented default, so nothing stored before Part 43
    // needs a migration and `NOTE_DOCUMENT_SCHEMA_VERSION` stays at 1.
    expect(
      safeParseNoteDocument({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { attachmentId: ATTACHMENT_ID, alt: "", width: null, height: null },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each(["left", "center", "right"])("accepts align=%s", (align) => {
    expect(safeParseNoteDocument(imageDoc({ align })).success).toBe(true);
  });

  it.each(["block", "inline"])("accepts wrap=%s", (wrap) => {
    expect(safeParseNoteDocument(imageDoc({ wrap })).success).toBe(true);
  });

  it.each([
    ["an unknown align value", { align: "diagonal" }],
    ["a justified align value borrowed from paragraphs", { align: "justify" }],
    ["a null align", { align: null }],
    ["an unknown wrap value", { wrap: "float" }],
    ["a null wrap", { wrap: null }],
    ["a string fullWidth", { fullWidth: "true" }],
    ["a numeric fullWidth", { fullWidth: 1 }],
    ["a null fullWidth", { fullWidth: null }],
    ["a null caption", { caption: null }],
    ["a numeric caption", { caption: 5 }],
    ["control characters in the caption", { caption: "line\u0000break" }],
  ])("rejects %s", (_label, attrs) => {
    expect(safeParseNoteDocument(imageDoc(attrs)).success).toBe(false);
  });

  it("bounds the caption at maxImageCaption", () => {
    expect(NOTE_DOCUMENT_LIMITS.maxImageCaption).toBe(1_000);
    const atLimit = "c".repeat(NOTE_DOCUMENT_LIMITS.maxImageCaption);
    expect(safeParseNoteDocument(imageDoc({ caption: atLimit })).success).toBe(true);

    const overLimit = safeParseNoteDocument(imageDoc({ caption: `${atLimit}c` }));
    expect(overLimit.success).toBe(false);
    if (!overLimit.success) {
      expect(overLimit.errors.join("; ")).toContain("caption attribute must be 0-1000");
    }
  });

  /**
   * The Part 42 invariant, re-asserted against the widened attribute set: the
   * four additions are two enumerations, a boolean, and bounded text, and the
   * allow-list loop still rejects anything URL-shaped.
   */
  it.each(["src", "url", "previewUrl", "dataUri", "href", "srcset", "captionUrl"])(
    "still rejects an image carrying a %s attribute",
    (attribute) => {
      expect(safeParseNoteDocument(imageDoc({ [attribute]: "blob:http://x/abc" })).success).toBe(
        false,
      );
      expect(
        safeParseNoteDocument(imageDoc({ [attribute]: "data:image/webp;base64,AAAA" })).success,
      ).toBe(false);
    },
  );

  describe("fullWidth versus inline wrap", () => {
    it("stores both verbatim rather than rejecting the pair", () => {
      // Rejecting it would let the editor build a document the API refuses,
      // which silently and permanently stops autosave for that session.
      const conflicting = imageDoc({ fullWidth: true, wrap: "inline" });
      const parsed = safeParseNoteDocument(conflicting);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.doc).toEqual(conflicting);
    });

    it("resolves the conflict deterministically in favour of fullWidth", () => {
      // A full-width figure spans the whole column, so there is no room beside
      // it for text to flow: the float could only be meaningless.
      expect(resolveNoteImageWrap({ wrap: "inline", fullWidth: true })).toBe("block");
      expect(resolveNoteImageWrap({ wrap: "inline", fullWidth: false })).toBe("inline");
      expect(resolveNoteImageWrap({ wrap: "block", fullWidth: true })).toBe("block");
    });

    it("emits the resolved wrap, so print and export match the editor", () => {
      const html = renderDocumentHtml(imageDoc({ fullWidth: true, wrap: "inline" }));
      expect(html).toContain('data-wrap="block"');
      expect(html).toContain('data-full-width="true"');
    });

    it("writes the resolved form back during recovery", () => {
      const recovered = migrateNoteDocument({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              attachmentId: ATTACHMENT_ID,
              src: "blob:http://localhost:3000/9d1f",
              alt: "Recovered",
              wrap: "inline",
              fullWidth: true,
            },
          },
        ],
      });
      expect(recovered.migrated).toBe(true);
      expect(recovered.doc).toEqual({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              attachmentId: ATTACHMENT_ID,
              alt: "Recovered",
              width: null,
              height: null,
              align: "center",
              wrap: "block",
              fullWidth: true,
              caption: "",
            },
          },
        ],
      });
    });

    it("replaces an unusable layout value during recovery instead of dropping the image", () => {
      const recovered = migrateNoteDocument({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              attachmentId: ATTACHMENT_ID,
              alt: "Kept",
              align: "diagonal",
              wrap: 7,
              fullWidth: "yes",
              caption: "Still here",
            },
          },
        ],
      });
      expect(recovered.migrated).toBe(true);
      expect(recovered.doc).toEqual({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              attachmentId: ATTACHMENT_ID,
              alt: "Kept",
              width: null,
              height: null,
              align: "center",
              wrap: "block",
              fullWidth: false,
              caption: "Still here",
            },
          },
        ],
      });
    });
  });

  describe("rendering", () => {
    it("wraps the image in a figure carrying the three layout attributes", () => {
      const html = renderDocumentHtml(imageDoc({ align: "left", wrap: "inline" }));
      expect(html).toBe(
        `<figure class="${NOTE_DOCUMENT_IMAGE_FIGURE_CLASS}" data-align="left" ` +
          `data-wrap="inline" data-full-width="false">` +
          `<img class="${NOTE_DOCUMENT_IMAGE_CLASS}" data-attachment-id="${ATTACHMENT_ID}" ` +
          `alt="A chart" loading="lazy" decoding="async">` +
          "</figure>",
      );
      expect(html).not.toContain("src=");
    });

    it("emits a figcaption only when the author wrote one", () => {
      expect(renderDocumentHtml(imageDoc())).not.toContain("figcaption");
      const html = renderDocumentHtml(imageDoc({ caption: "Figure 1" }));
      expect(html).toContain(
        `<figcaption class="${NOTE_DOCUMENT_IMAGE_CAPTION_CLASS}">Figure 1</figcaption>`,
      );
    });

    it("escapes caption text rather than trusting it", () => {
      const html = renderDocumentHtml(imageDoc({ caption: '"><script>alert(1)</script>' }));
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("emits nothing but its own constants — no stored class or style", () => {
      // The allow-list rejects those attributes outright, so the renderer is not
      // the only line of defence; it still emits only literals it owns.
      const html = renderDocumentHtml(imageDoc({ caption: "Plain" }));
      expect(html).not.toContain("style=");
      expect(html.match(/class="/gu)).toHaveLength(3);
    });
  });

  describe("plain-text projection", () => {
    it("contributes alt first and caption second", () => {
      // Alt describes the image and a screen reader reaches it first; the
      // caption is the visible text printed beneath the figure.
      expect(
        extractNoteContentPlain({
          type: "doc",
          content: [imageNode({ alt: "Bar chart", caption: "Figure 1" })],
        }),
      ).toBe("Bar chart\nFigure 1");
    });

    it("omits either half when it is empty", () => {
      expect(
        extractNoteContentPlain({
          type: "doc",
          content: [imageNode({ alt: "", caption: "Only a caption" })],
        }),
      ).toBe("Only a caption");
      expect(
        extractNoteContentPlain({
          type: "doc",
          content: [imageNode({ alt: "Only alt", caption: "" })],
        }),
      ).toBe("Only alt");
      expect(
        extractNoteContentPlain({ type: "doc", content: [imageNode({ alt: "", caption: "" })] }),
      ).toBe("");
    });

    it("recovers a caption from a malformed node during text-only recovery", () => {
      const recovered = migrateNoteDocument({
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: "data:image/png;base64,AAA", alt: "Lost chart", caption: "Its caption" },
          },
        ],
      });
      expect(extractNoteContentPlain(recovered.doc)).toContain("Lost chart");
      expect(extractNoteContentPlain(recovered.doc)).toContain("Its caption");
    });
  });

  it("does not change the contract version for the additive Part 43 widening", () => {
    // Adding an attribute with a documented default is additive: every stored
    // v1 document is still valid v1 and still means what it meant. The trigger
    // for the first bump is removing, narrowing, or re-typing one.
    expect(NOTE_DOCUMENT_SCHEMA_VERSION).toBe(1);
  });
});

describe("Part 44 generic attachment contract", () => {
  const ATTACHMENT_ID = "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

  const attachmentNode = (attrs: Record<string, unknown> = {}) => ({
    type: "attachment",
    attrs: {
      attachmentId: ATTACHMENT_ID,
      name: "quarterly-report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 245_760,
      ...attrs,
    },
  });

  const attachmentDocument = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      attachmentNode(),
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ],
  };

  it("accepts an attachment as a block node and round-trips it unchanged", () => {
    const parsed = safeParseNoteDocument(attachmentDocument);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.doc).toEqual(attachmentDocument);
    expect(noteDocumentSchema.safeParse(parsed.doc).success).toBe(true);
  });

  it("accepts an attachment wherever a block node is allowed", () => {
    const nested = {
      type: "doc",
      content: [
        { type: "blockquote", content: [attachmentNode()] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph" }, attachmentNode()] }],
        },
      ],
    };
    expect(safeParseNoteDocument(nested).success).toBe(true);
  });

  /*
   * The load-bearing invariant of the whole part.
   *
   * The node's only handle on the bytes is `attachmentId`, resolved through an
   * endpoint that re-checks workspace membership on every request. A URL-shaped
   * attribute would survive a copy, an export, and a share — outliving the
   * reader's permission and, for a `blob:` or `data:` value, breaking the note
   * the moment the tab that minted it closed.
   */
  it.each(["src", "url", "href", "downloadUrl", "contentUrl", "objectKey"])(
    "rejects a URL-shaped attribute named %s",
    (attribute) => {
      const result = safeParseNoteDocument({
        type: "doc",
        content: [attachmentNode({ [attribute]: "https://storage.example/secret.pdf" })],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.join("; ")).toContain(`not allowed on attachment: ${attribute}`);
      }
      // Temporary sources are refused by the same rule, so the saved document
      // can never depend on a URL that dies with the tab.
      for (const value of ["blob:https://app.example/1", "data:application/pdf;base64,AAAA"]) {
        expect(
          safeParseNoteDocument({
            type: "doc",
            content: [attachmentNode({ [attribute]: value })],
          }).success,
        ).toBe(false);
      }
    },
  );

  it.each([
    ["a missing attachmentId", attachmentNode({ attachmentId: undefined })],
    ["a non-UUID attachmentId", attachmentNode({ attachmentId: "../../etc/passwd" })],
    ["a missing name", attachmentNode({ name: undefined })],
    ["an empty name", attachmentNode({ name: "" })],
    ["control characters in the name", attachmentNode({ name: "report\u0000.pdf" })],
    [
      "an oversized name",
      attachmentNode({ name: `${"a".repeat(NOTE_DOCUMENT_LIMITS.maxAttachmentName)}b` }),
    ],
    ["a missing mimeType", attachmentNode({ mimeType: undefined })],
    ["a malformed mimeType", attachmentNode({ mimeType: "not a mime type" })],
    ["a negative sizeBytes", attachmentNode({ sizeBytes: -1 })],
    ["a fractional sizeBytes", attachmentNode({ sizeBytes: 12.5 })],
    [
      "an oversized sizeBytes",
      attachmentNode({ sizeBytes: NOTE_DOCUMENT_LIMITS.maxAttachmentSizeBytes + 1 }),
    ],
    ["children", { ...attachmentNode(), content: [{ type: "paragraph" }] }],
    ["marks", { ...attachmentNode(), marks: [{ type: "link", attrs: SAFE_LINK_ATTRS }] }],
    ["stray fields", { ...attachmentNode(), text: "x" }],
  ])("rejects an attachment with %s", (_label, node) => {
    expect(safeParseNoteDocument({ type: "doc", content: [node] }).success).toBe(false);
  });

  it("accepts the exact boundary values on every bounded attribute", () => {
    const atBounds = attachmentNode({
      name: "a".repeat(NOTE_DOCUMENT_LIMITS.maxAttachmentName),
      sizeBytes: NOTE_DOCUMENT_LIMITS.maxAttachmentSizeBytes,
    });
    expect(safeParseNoteDocument({ type: "doc", content: [atBounds] }).success).toBe(true);
    // Zero is legal: an empty file is still a file, and the server measured it.
    expect(
      safeParseNoteDocument({ type: "doc", content: [attachmentNode({ sizeBytes: 0 })] }).success,
    ).toBe(true);
  });

  it("rejects an attachment node with no attrs at all", () => {
    expect(safeParseNoteDocument({ type: "doc", content: [{ type: "attachment" }] }).success).toBe(
      false,
    );
  });

  it("bounds how many attachments one note may reference", () => {
    const atLimit = {
      type: "doc",
      content: Array.from({ length: NOTE_DOCUMENT_LIMITS.maxAttachments }, () => attachmentNode()),
    };
    const overLimit = {
      type: "doc",
      content: Array.from({ length: NOTE_DOCUMENT_LIMITS.maxAttachments + 1 }, () =>
        attachmentNode(),
      ),
    };
    expect(safeParseNoteDocument(atLimit).success).toBe(true);
    expect(safeParseNoteDocument(overLimit).success).toBe(false);
  });

  it("returns the four reviewed attributes, or null, and never throws", () => {
    expect(noteDocumentAttachmentAttrs(attachmentNode().attrs)).toEqual({
      attachmentId: ATTACHMENT_ID,
      name: "quarterly-report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 245_760,
    });
    expect(noteDocumentAttachmentAttrs(undefined)).toBeNull();
    expect(noteDocumentAttachmentAttrs(null)).toBeNull();
    expect(noteDocumentAttachmentAttrs("nope")).toBeNull();
    expect(noteDocumentAttachmentAttrs({ attachmentId: "nope" })).toBeNull();
  });

  it("renders a figure with the contract classes and no link of any kind", () => {
    expect(NOTE_DOCUMENT_ATTACHMENT_CLASS).toBe("notted-attachment");
    const html = renderDocumentHtml(attachmentDocument);
    expect(html).toContain(`<figure class="${NOTE_DOCUMENT_ATTACHMENT_CLASS}"`);
    expect(html).toContain(`data-attachment-id="${ATTACHMENT_ID}"`);
    expect(html).toContain(`class="${NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS}"`);
    expect(html).toContain(`class="${NOTE_DOCUMENT_ATTACHMENT_META_CLASS}"`);
    expect(html).toContain(`class="${NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS}"`);
    // This module knows neither the workspace nor the reader's authorization,
    // so it never invents a target. Part 63's exporter substitutes one.
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("blob:");
    expect(html).not.toContain("data:application");
  });

  it("escapes the filename rather than trusting it", () => {
    const html = renderDocumentHtml({
      type: "doc",
      content: [attachmentNode({ name: '"><script>alert(1)</script>.pdf' })],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders nothing for an attachment whose attributes do not validate", () => {
    expect(
      renderDocumentHtml({
        type: "doc",
        content: [attachmentNode({ attachmentId: "not-a-uuid" })],
      }),
    ).toBe("");
  });

  it("contributes the filename to the plain-text projection", () => {
    expect(extractNoteContentPlain(attachmentDocument)).toBe("Before\nquarterly-report.pdf\nAfter");
  });

  it("does not change the contract version for the additive Part 44 widening", () => {
    // Adding a node type is additive: every stored v1 document is still valid
    // v1 and still means what it meant. The trigger for the first bump is
    // removing, narrowing, or re-typing something that already exists.
    expect(NOTE_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(NOTE_DOCUMENT_NODE_TYPES).toContain("attachment");
  });
});

describe("Part 48 checklist counting", () => {
  const taskItem = (checked: unknown, content: readonly unknown[] = []) => ({
    type: "taskItem",
    ...(checked === undefined ? {} : { attrs: { checked } }),
    content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }, ...content],
  });

  it("counts nothing in a document with no task items", () => {
    expect(countChecklist({ type: "doc", content: [] })).toEqual({ done: 0, total: 0 });
    expect(
      countChecklist({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
          },
        ],
      }),
    ).toEqual({ done: 0, total: 0 });
  });

  it("counts checked items against the total", () => {
    expect(
      countChecklist({
        type: "doc",
        content: [{ type: "taskList", content: [taskItem(true), taskItem(false), taskItem(true)] }],
      }),
    ).toEqual({ done: 2, total: 3 });
  });

  /**
   * A nested list is the case a flat `content[0].content` scan would silently
   * under-report, and the editor allows it — a task item may contain another
   * task list.
   */
  it("counts task items nested inside another task item", () => {
    expect(
      countChecklist({
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              taskItem(false, [{ type: "taskList", content: [taskItem(true), taskItem(false)] }]),
              taskItem(true),
            ],
          },
        ],
      }),
    ).toEqual({ done: 2, total: 4 });
  });

  it("treats a missing or non-boolean checked attribute as unchecked, not as absent", () => {
    expect(
      countChecklist({
        type: "doc",
        content: [
          { type: "taskList", content: [taskItem(undefined), taskItem("true"), taskItem(1)] },
        ],
      }),
    ).toEqual({ done: 0, total: 3 });
  });

  it("survives values that are not documents at all", () => {
    for (const value of [null, undefined, 42, "doc", []]) {
      expect(countChecklist(value)).toEqual({ done: 0, total: 0 });
    }
  });

  /** The projection the notes service stores must match the document it stored. */
  it("agrees with the plain-text projection about which document has a checklist", () => {
    const document = {
      type: "doc",
      content: [{ type: "taskList", content: [taskItem(true), taskItem(false)] }],
    };
    expect(extractNoteContentPlain(document)).toBe("Item\nItem");
    expect(countChecklist(document)).toEqual({ done: 1, total: 2 });
  });
});
