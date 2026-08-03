import { describe, expect, it } from "vitest";

import {
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_SCHEMA_VERSION,
  NoteDocumentMigrationError,
  extractNoteContentPlain,
  migrateNoteDocument,
  noteDocumentSchema,
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
