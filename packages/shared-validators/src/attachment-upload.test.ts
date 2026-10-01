import { describe, expect, it } from "vitest";

import { attachmentFileMimeTypeSchema, attachmentUploadKindSchema } from "./attachment.schema";

describe("generic attachment upload contract", () => {
  it("defaults to original-byte generic uploads and accepts explicit image processing", () => {
    expect(attachmentUploadKindSchema.parse(undefined)).toBe("file");
    expect(attachmentUploadKindSchema.parse("image")).toBe("image");
    expect(attachmentUploadKindSchema.safeParse("other").success).toBe(false);
  });
  it("accepts descriptive MIME grammar without a format allow-list", () => {
    expect(attachmentFileMimeTypeSchema.parse("application/x-custom")).toBe("application/x-custom");
    expect(attachmentFileMimeTypeSchema.safeParse("text/html\r\nX-Header: 1").success).toBe(false);
  });
});
