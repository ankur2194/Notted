import { MAX_ATTACHMENT_UPLOAD_BYTES } from "@notted/shared-validators";
import { describe, expect, it } from "vitest";

import { admitUpload, ATTACHMENT_SIGNATURE_HEAD_BYTES } from "./attachment-admission";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x11),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(64, 0x20)]);

function zipContainer(name: string): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04_03_4b_50, 0);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, Buffer.from(name, "latin1"), Buffer.alloc(64, 0x00)]);
}

describe("admitUpload", () => {
  it("routes a recognised image to the image path, whatever it is named", () => {
    expect(admitUpload(PNG, "invoice.pdf")).toEqual({
      ok: true,
      admitted: { kind: "image", mimeType: "image/png" },
    });
  });

  it("routes a signature-verified binary to the file path and forces its extension", () => {
    expect(admitUpload(PDF, "Quarterly Report.pdf")).toEqual({
      ok: true,
      admitted: {
        kind: "file",
        mimeType: "application/pdf",
        extension: ".pdf",
        viaTextScan: false,
      },
    });
    // Spoofed extension: the bytes win and the download extension is corrected.
    expect(admitUpload(PDF, "payload.exe")).toMatchObject({
      ok: true,
      admitted: { mimeType: "application/pdf", extension: ".pdf" },
    });
  });

  it("narrows an OOXML package by extension but never invents one", () => {
    const ooxml = zipContainer("[Content_Types].xml");
    expect(admitUpload(ooxml, "notes.docx")).toMatchObject({
      admitted: {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: ".docx",
      },
    });
    expect(admitUpload(zipContainer("images/a.png"), "notes.docx")).toMatchObject({
      admitted: { mimeType: "application/zip", extension: ".zip" },
    });
  });

  it("admits allow-listed text and code as text/plain, preserving the extension", () => {
    expect(admitUpload(Buffer.from("print('hi')\n", "utf8"), "script.py")).toEqual({
      ok: true,
      admitted: {
        kind: "file",
        mimeType: "text/plain",
        extension: ".py",
        viaTextScan: true,
      },
    });
    // The security property that makes accepting `.html` acceptable: it is
    // stored as text/plain, never as text/html, whatever the client declared.
    expect(admitUpload(Buffer.from("<script>alert(1)</script>", "utf8"), "x.html")).toMatchObject({
      admitted: { mimeType: "text/plain", extension: ".html" },
    });
  });

  it("refuses an unrecognised payload and an unsafe text payload distinguishably", () => {
    expect(admitUpload(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "setup.exe")).toEqual({
      ok: false,
      rejection: { reason: "unsupported" },
    });
    expect(admitUpload(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]), "notes.txt")).toEqual({
      ok: false,
      rejection: { reason: "unsafe_text", detail: "nul_byte" },
    });
    expect(admitUpload(Buffer.from([0xff, 0xfe, 0x41]), "notes.txt")).toEqual({
      ok: false,
      rejection: { reason: "unsafe_text", detail: "invalid_utf8" },
    });
  });

  it("refuses an empty payload and one past the shared ceiling", () => {
    expect(admitUpload(Buffer.alloc(0), "notes.txt")).toEqual({
      ok: false,
      rejection: { reason: "empty" },
    });
    const oversize = Buffer.alloc(MAX_ATTACHMENT_UPLOAD_BYTES + 1, 0x61);
    Buffer.from("%PDF-1.7", "latin1").copy(oversize, 0);
    expect(admitUpload(oversize, "big.pdf")).toEqual({
      ok: false,
      rejection: { reason: "too_large" },
    });
  });

  it("strips path separators and bidi overrides out of the extension it consults", () => {
    // `evil.exe` with a right-to-left override rendering as `.txt`: the override
    // is removed before the extension is read, so the real extension is seen.
    const disguised = "evil‮txt.exe";
    expect(admitUpload(Buffer.from("harmless", "utf8"), disguised)).toEqual({
      ok: false,
      rejection: { reason: "unsupported" },
    });
    // A traversal attempt contributes no directory component to the decision.
    expect(admitUpload(Buffer.from("harmless", "utf8"), "../../etc/passwd.txt")).toMatchObject({
      ok: true,
      admitted: { mimeType: "text/plain", extension: ".txt" },
    });
  });

  it("reads a head window large enough for every supported signature", () => {
    // TAR's `ustar` magic sits at offset 257; the window has to cover it.
    expect(ATTACHMENT_SIGNATURE_HEAD_BYTES).toBeGreaterThanOrEqual(1_024);
  });
});
