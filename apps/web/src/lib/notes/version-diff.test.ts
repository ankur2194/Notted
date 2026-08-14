import { describe, expect, it } from "vitest";

import {
  diffVersionDocuments,
  projectVersionDocument,
  VERSION_DIFF_MAX_TOKENS,
} from "./version-diff";

import type { NoteDocument } from "@notted/shared-types";

const doc = (content: unknown[]): NoteDocument => ({ type: "doc", content }) as NoteDocument;

describe("semantic version diff", () => {
  it("aligns duplicate occurrences without collapsing them", () => {
    const result = diffVersionDocuments(
      doc([
        { type: "paragraph", content: [{ type: "text", text: "same" }] },
        { type: "paragraph", content: [{ type: "text", text: "same" }] },
      ]),
      doc([
        { type: "paragraph", content: [{ type: "text", text: "same" }] },
        { type: "paragraph", content: [{ type: "text", text: "new" }] },
        { type: "paragraph", content: [{ type: "text", text: "same" }] },
      ]),
    );
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
  });

  it("projects marks, tasks, code, tables, images, attachments, and page breaks", () => {
    const lines = projectVersionDocument(
      doc([
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "linked",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
            { type: "mention", attrs: { id: "u", label: "Ada" } },
          ],
        },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: true }, content: [] }],
        },
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const x = 1" }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [] }],
            },
          ],
        },
        {
          type: "image",
          attrs: {
            attachmentId: "a",
            alt: "diagram",
            caption: "caption",
            width: 10,
            height: 20,
            align: "right",
            wrap: "inline",
            fullWidth: false,
          },
        },
        {
          type: "attachment",
          attrs: {
            attachmentId: "b",
            name: "file.pdf",
            mimeType: "application/pdf",
            sizeBytes: 20,
          },
        },
        { type: "pageBreak" },
      ]),
    );
    expect(lines.join("\n")).toMatch(
      /link|Task checked|Code \(typescript\)|Header cell|Image:|Attachment:|Page break/,
    );
  });

  it("emits bounded inline word additions and deletions for changed text blocks", () => {
    const result = diffVersionDocuments(
      doc([{ type: "paragraph", content: [{ type: "text", text: "The old concise text" }] }]),
      doc([{ type: "paragraph", content: [{ type: "text", text: "The new detailed text" }] }]),
    );
    expect(
      result.before.some((segment) => segment.kind === "deleted" && segment.text === "old"),
    ).toBe(true);
    expect(result.after.some((segment) => segment.kind === "added" && segment.text === "new")).toBe(
      true,
    );
    expect(
      result.after.some((segment) => segment.kind === "added" && segment.text === "detailed"),
    ).toBe(true);
  });

  it("returns a safe fallback before quadratic work exceeds its bound", () => {
    const paragraphs = Array.from({ length: VERSION_DIFF_MAX_TOKENS + 1 }, (_, index) => ({
      type: "paragraph",
      content: [{ type: "text", text: String(index) }],
    }));
    expect(diffVersionDocuments(doc(paragraphs), doc(paragraphs)).tooLarge).toBe(true);
  });
});
