import { ATTACHMENT_TEXT_EXTENSIONS } from "@notted/shared-validators";
import { describe, expect, it } from "vitest";

import { isAllowedTextExtension, scanTextUpload, TEXT_SAFETY_SCAN_BYTES } from "./text-safety";

const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");

describe("isAllowedTextExtension", () => {
  it("accepts exactly the documented text and code extensions", () => {
    for (const extension of ATTACHMENT_TEXT_EXTENSIONS) {
      expect(isAllowedTextExtension(extension)).toBe(true);
    }
    expect(ATTACHMENT_TEXT_EXTENSIONS).toContain(".md");
    expect(ATTACHMENT_TEXT_EXTENSIONS).toContain(".py");
    expect(ATTACHMENT_TEXT_EXTENSIONS).toContain(".html");
  });

  it("rejects anything else, including near-misses and empty", () => {
    for (const extension of ["", ".exe", ".sh", ".php", ".TXT", "txt", ".pdf", ".yml"]) {
      expect(isAllowedTextExtension(extension)).toBe(false);
    }
  });
});

describe("scanTextUpload", () => {
  it("admits every documented text and code type when the bytes are clean UTF-8", () => {
    const samples: readonly (readonly [string, string])[] = [
      [".txt", "plain notes\n"],
      [".md", "# Heading\n\nSome *markdown*.\n"],
      [".csv", "name,size\nreport,12\n"],
      [".json", '{"ok":true}\n'],
      [".xml", '<?xml version="1.0"?><root><child/></root>'],
      [".js", "export const answer = 42;\n"],
      [".ts", "export const answer: number = 42;\n"],
      [".html", "<!doctype html><html><body><p>hi</p></body></html>"],
      [".htm", "<html><body>legacy</body></html>"],
      [".css", ".notted { color: #123456; }\n"],
      [".py", "def main() -> None:\n    print('hi')\n"],
    ];
    for (const [extension, content] of samples) {
      expect(scanTextUpload(utf8(content), extension)).toEqual({ ok: true });
    }
  });

  it("accepts non-ASCII UTF-8, including astral-plane characters", () => {
    expect(scanTextUpload(utf8("héllo — 漢字 🎉\n"), ".txt")).toEqual({ ok: true });
    // A four-byte sequence at the very start and at the very end.
    expect(scanTextUpload(utf8("🎉 middle 🎉"), ".md")).toEqual({ ok: true });
  });

  it("refuses an extension that is not on the allow-list before scanning anything", () => {
    expect(scanTextUpload(utf8("harmless"), ".exe")).toEqual({ ok: false, reason: "extension" });
    expect(scanTextUpload(utf8("harmless"), "")).toEqual({ ok: false, reason: "extension" });
  });

  it("refuses an empty payload", () => {
    expect(scanTextUpload(Buffer.alloc(0), ".txt")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a NUL byte anywhere, including far beyond the UTF-8 window", () => {
    expect(scanTextUpload(Buffer.from([0x68, 0x00, 0x69]), ".txt")).toEqual({
      ok: false,
      reason: "nul_byte",
    });
    // The whole-buffer NUL check is what stops a binary payload being smuggled
    // in past the bounded UTF-8 window under a `.txt` name.
    const smuggled = Buffer.concat([
      Buffer.alloc(TEXT_SAFETY_SCAN_BYTES, 0x41),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    expect(scanTextUpload(smuggled, ".txt")).toEqual({ ok: false, reason: "nul_byte" });
  });

  it("refuses a binary payload wearing a text extension", () => {
    // A real ELF header: NUL bytes are its very first control.
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])]);
    expect(scanTextUpload(elf, ".txt")).toEqual({ ok: false, reason: "nul_byte" });
    // A NUL-free but invalid-UTF-8 payload is caught by the second control.
    expect(scanTextUpload(Buffer.from([0xff, 0xfe, 0x41, 0x42]), ".txt")).toEqual({
      ok: false,
      reason: "invalid_utf8",
    });
  });

  it("refuses every class of invalid UTF-8", () => {
    const invalid: readonly (readonly [string, readonly number[]])[] = [
      ["stray continuation byte", [0x41, 0x80, 0x42]],
      ["truncated two-byte sequence", [0x41, 0xc3]],
      ["overlong two-byte encoding of '/'", [0xc0, 0xaf]],
      ["overlong three-byte encoding", [0xe0, 0x80, 0xaf]],
      ["overlong four-byte encoding", [0xf0, 0x80, 0x80, 0xaf]],
      ["UTF-16 surrogate half U+D800", [0xed, 0xa0, 0x80]],
      ["UTF-16 surrogate half U+DFFF", [0xed, 0xbf, 0xbf]],
      ["code point beyond U+10FFFF", [0xf5, 0x80, 0x80, 0x80]],
      ["invalid lead byte 0xFF", [0xff]],
      ["missing continuation in three-byte sequence", [0xe2, 0x28, 0xa1]],
    ];
    for (const [label, bytes] of invalid) {
      expect(scanTextUpload(Buffer.from(bytes), ".txt"), label).toEqual({
        ok: false,
        reason: "invalid_utf8",
      });
    }
  });

  it("tolerates a multi-byte sequence split by the scan window, but only there", () => {
    // A payload larger than the window whose last in-window byte begins a
    // sequence that continues past it. That is an artefact of the bound, not a
    // defect in the file, so it must pass.
    const filler = Buffer.alloc(TEXT_SAFETY_SCAN_BYTES - 1, 0x41);
    const split = Buffer.concat([filler, utf8("é"), Buffer.alloc(16, 0x42)]);
    expect(split.byteLength).toBeGreaterThan(TEXT_SAFETY_SCAN_BYTES);
    expect(scanTextUpload(split, ".txt")).toEqual({ ok: true });

    // The same truncation inside a payload that FITS in the window is a genuine
    // encoding error and must still be refused.
    expect(scanTextUpload(Buffer.from([0x41, 0xe2, 0x82]), ".txt")).toEqual({
      ok: false,
      reason: "invalid_utf8",
    });
  });

  it("scans a large clean payload without decoding it", () => {
    const large = Buffer.alloc(TEXT_SAFETY_SCAN_BYTES * 4, 0x61);
    expect(scanTextUpload(large, ".md")).toEqual({ ok: true });
    // Invalid bytes AFTER the window are deliberately not detected: the bound is
    // a documented cost/benefit decision and the NUL check is the backstop.
    const tailInvalid = Buffer.concat([large, Buffer.from([0xff, 0xff])]);
    expect(scanTextUpload(tailInvalid, ".md")).toEqual({ ok: true });
  });
});
