import { describe, expect, it } from "vitest";

import {
  isAllowedDocumentLink,
  noteDocumentToSafeHtml,
  prepareNoteDocumentForEditor,
} from "./document-contract";

describe("editor document contract bridge", () => {
  it("converts an unsupported historical node to a paragraph without losing its text", () => {
    const result = prepareNoteDocumentForEditor({
      type: "doc",
      content: [
        {
          type: "legacyCallout",
          content: [{ type: "text", text: "Recovered historical text" }],
        },
      ],
    });

    expect(result.migrated).toBe(true);
    expect(result.doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Recovered historical text" }],
        },
      ],
    });
  });

  it("drops unsafe links and escapes HTML-like text before rendering", () => {
    const result = noteDocumentToSafeHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: '<script>alert("unsafe")</script>',
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    });

    expect(result.migrated).toBe(true);
    expect(result.html).toContain("&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("javascript:");
    expect(result.html).not.toContain("href=");
    expect(isAllowedDocumentLink("javascript:alert(1)")).toBe(false);
  });

  it("preserves a clean current document without migration", () => {
    const currentDocument = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Current content" }],
        },
      ],
    };

    const prepared = prepareNoteDocumentForEditor(currentDocument);
    const rendered = noteDocumentToSafeHtml(currentDocument);

    expect(prepared.migrated).toBe(false);
    expect(prepared.doc).toBe(currentDocument);
    expect(rendered).toMatchObject({
      doc: currentDocument,
      migrated: false,
      html: "<p>Current content</p>",
    });
  });
});
