import { describe, expect, it } from "vitest";

import {
  canonicalFileExtension,
  FILE_SIGNATURE_HEAD_BYTES,
  sniffFileMediaType,
  type SniffedFileType,
} from "./file-signature";

/*
 * Every fixture is BUILT HERE rather than committed as a binary file, exactly as
 * `image-fixtures.ts` and `e2e/note-images.spec.ts` build theirs. Committed
 * binaries cannot be reviewed in a diff, and the only thing these tests need is
 * a byte-accurate header — the payload after it is irrelevant to a sniffer.
 */

function withHead(signature: readonly number[] | Buffer, padding = 128): Buffer {
  const head = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  return Buffer.concat([head, Buffer.alloc(padding, 0x41)]);
}

/** A ZIP local file header whose first entry is `name`. */
function zipContainer(name: string): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04_03_4b_50, 0); // "PK\x03\x04" little-endian
  header.writeUInt16LE(name.length, 26); // file name length
  return Buffer.concat([header, Buffer.from(name, "latin1"), Buffer.alloc(64, 0x00)]);
}

/** A TAR whose `ustar` magic sits at offset 257 inside the first header block. */
function tarArchive(magic: readonly number[]): Buffer {
  const block = Buffer.alloc(512, 0x00);
  block.write("notes.txt", 0, "latin1");
  Buffer.from(magic).copy(block, 257);
  return block;
}

const PDF = withHead(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"));
const RTF = withHead(Buffer.from("{\\rtf1\\ansi\\deff0 hello}", "latin1"));
const SEVEN_ZIP = withHead([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const RAR4 = withHead([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5 = withHead([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const GZIP = withHead([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
const PLAIN_ZIP = zipContainer("photos/holiday.jpg");
const OOXML = zipContainer("[Content_Types].xml");
const TAR_POSIX = tarArchive([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]);
const TAR_GNU = tarArchive([0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00]);

describe("sniffFileMediaType", () => {
  it("identifies every signature-verified type from its magic bytes alone", () => {
    const cases: readonly (readonly [Buffer, SniffedFileType])[] = [
      [PDF, "application/pdf"],
      [RTF, "application/rtf"],
      [SEVEN_ZIP, "application/x-7z-compressed"],
      [RAR4, "application/vnd.rar"],
      [RAR5, "application/vnd.rar"],
      [GZIP, "application/gzip"],
      [PLAIN_ZIP, "application/zip"],
      [TAR_POSIX, "application/x-tar"],
      [TAR_GNU, "application/x-tar"],
    ];
    for (const [bytes, expected] of cases) {
      // No extension is supplied: none of these needs one.
      expect(sniffFileMediaType(bytes, "")).toBe(expected);
    }
  });

  it("also detects the empty-archive and spanned ZIP end markers", () => {
    expect(sniffFileMediaType(withHead([0x50, 0x4b, 0x05, 0x06]), "")).toBe("application/zip");
    expect(sniffFileMediaType(withHead([0x50, 0x4b, 0x07, 0x08]), "")).toBe("application/zip");
  });

  it("disambiguates DOCX and XLSX from a plain ZIP using the OOXML marker AND the extension", () => {
    expect(sniffFileMediaType(OOXML, ".docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(sniffFileMediaType(OOXML, ".xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // Marker present but no recognised extension: it stays a ZIP rather than
    // guessing. A ZIP is exactly what it is.
    expect(sniffFileMediaType(OOXML, "")).toBe("application/zip");
    expect(sniffFileMediaType(OOXML, ".pptx")).toBe("application/zip");
  });

  it("never lets the extension alone create a type", () => {
    // The extension can only NARROW a type the bytes already proved. A plain
    // ZIP named `.docx` has no OOXML marker, so it is still a ZIP.
    expect(sniffFileMediaType(PLAIN_ZIP, ".docx")).toBe("application/zip");
    expect(sniffFileMediaType(PLAIN_ZIP, ".xlsx")).toBe("application/zip");
    // And a non-container named `.docx` is nothing at all.
    expect(sniffFileMediaType(withHead([0x00, 0x01, 0x02, 0x03]), ".docx")).toBeNull();
  });

  it("rejects a spoofed MIME or extension whose bytes disagree", () => {
    // ZIP bytes under a .pdf extension are ZIP bytes.
    expect(sniffFileMediaType(PLAIN_ZIP, ".pdf")).toBe("application/zip");
    // PDF bytes under a .zip extension are a PDF.
    expect(sniffFileMediaType(PDF, ".zip")).toBe("application/pdf");
    // A Windows executable pretending to be a PDF is refused outright.
    expect(sniffFileMediaType(withHead([0x4d, 0x5a, 0x90, 0x00]), ".pdf")).toBeNull();
    // An ELF binary named `.txt` is likewise not a file signature at all; the
    // text path is the only thing that could admit it, and its NUL scan will not.
    expect(sniffFileMediaType(withHead([0x7f, 0x45, 0x4c, 0x46]), ".txt")).toBeNull();
  });

  it("requires the PDF signature at offset zero, so a polyglot cannot slip through", () => {
    const prefixed = Buffer.concat([Buffer.from("GIF89a", "latin1"), PDF]);
    expect(sniffFileMediaType(prefixed, ".pdf")).toBeNull();
  });

  it("returns null for truncated, empty, and unrecognised heads", () => {
    expect(sniffFileMediaType(Buffer.alloc(0), ".pdf")).toBeNull();
    expect(sniffFileMediaType(Buffer.from("%PD", "latin1"), ".pdf")).toBeNull();
    expect(sniffFileMediaType(Buffer.from([0x50, 0x4b]), ".zip")).toBeNull();
    expect(sniffFileMediaType(Buffer.from("hello, world", "utf8"), ".txt")).toBeNull();
    // A TAR truncated before offset 257 has no identity yet.
    expect(sniffFileMediaType(TAR_POSIX.subarray(0, 200), ".tar")).toBeNull();
  });

  it("distinguishes RAR 5 from RAR 4 without misreading the shared prefix", () => {
    // RAR 5's signature is RAR 4's plus one byte; both must resolve to the same
    // MIME type, and neither may be rejected by the other's test.
    expect(sniffFileMediaType(RAR4, ".rar")).toBe("application/vnd.rar");
    expect(sniffFileMediaType(RAR5, ".rar")).toBe("application/vnd.rar");
  });

  it("only inspects the bounded head, so a huge payload costs nothing extra", () => {
    const large = Buffer.concat([PDF, Buffer.alloc(4 * 1_024 * 1_024, 0x20)]);
    expect(sniffFileMediaType(large.subarray(0, FILE_SIGNATURE_HEAD_BYTES), ".pdf")).toBe(
      "application/pdf",
    );
    expect(FILE_SIGNATURE_HEAD_BYTES).toBeGreaterThan(257 + 8);
  });
});

describe("canonicalFileExtension", () => {
  it("maps every sniffed type to exactly one download extension", () => {
    expect(canonicalFileExtension("application/pdf")).toBe(".pdf");
    expect(canonicalFileExtension("application/zip")).toBe(".zip");
    expect(
      canonicalFileExtension(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(".docx");
    expect(
      canonicalFileExtension("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe(".xlsx");
    expect(canonicalFileExtension("application/vnd.rar")).toBe(".rar");
    expect(canonicalFileExtension("application/x-7z-compressed")).toBe(".7z");
    expect(canonicalFileExtension("application/x-tar")).toBe(".tar");
    expect(canonicalFileExtension("application/gzip")).toBe(".gz");
    expect(canonicalFileExtension("application/rtf")).toBe(".rtf");
  });
});
