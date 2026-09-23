import { describe, expect, it } from "vitest";

import { renderDocumentHtml, renderPublicDocumentHtml } from "./index";

const imageId = "30000000-0000-4000-8000-000000000001";
const fileId = "30000000-0000-4000-8000-000000000002";
const name = `Report <draft> & "notes".txt`;
const document = {
  type: "doc",
  content: [
    { type: "image", attrs: { attachmentId: imageId, alt: "Diagram" } },
    {
      type: "attachment",
      attrs: { attachmentId: fileId, name, mimeType: "text/plain", sizeBytes: 10 },
    },
  ],
};

describe("public-only attachment HTML", () => {
  it("adds an escaped, no-referrer, print-hidden file download without changing export HTML", () => {
    const original = renderDocumentHtml(document);
    expect(original).not.toContain("href=");
    const html = renderPublicDocumentHtml(
      document,
      (id) => `/public/${id}/image`,
      (id) => `/public/${id}/file?name="&download=1`,
    );
    expect(html).toContain(`src="/public/${imageId}/image"`);
    expect(html).toContain(
      'href="/public/30000000-0000-4000-8000-000000000002/file?name=&quot;&amp;download=1"',
    );
    expect(html).toContain('rel="noreferrer" referrerpolicy="no-referrer"');
    expect(html).toContain("data-notted-print-hide");
    expect(html).toContain("Download Report &lt;draft&gt; &amp; &quot;notes&quot;.txt");
    expect(html).not.toContain(`data-attachment-id="${fileId}"`);
    expect(html).not.toContain("<draft>");
    expect(renderDocumentHtml(document)).toBe(original);
  });

  it("does not create a link for invalid attachment attributes", () => {
    const invalid = {
      type: "doc",
      content: [{ type: "attachment", attrs: { attachmentId: "not-a-uuid", name } }],
    };
    expect(
      renderPublicDocumentHtml(
        invalid,
        () => "",
        () => "",
      ),
    ).not.toContain("href=");
  });
});
