import { describe, expect, it } from "vitest";

import {
  NOTE_DOCUMENT_CODE_LANGUAGES,
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_NODE_TYPES,
  NOTE_DOCUMENT_PAGE_BREAK_CLASS,
  NOTE_DOCUMENT_SCHEMA_VERSION,
  NoteDocumentMigrationError,
  extractNoteContentPlain,
  migrateNoteDocument,
  noteDocumentSchema,
  normalizeNoteDocumentCodeLanguage,
  renderDocumentHtml,
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
