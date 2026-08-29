import { describe, expect, it } from "vitest";

import { sniffImageMediaType, type SniffedImageType } from "./image-signature";

function pad(head: Buffer, size = 64): Buffer {
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

const jpeg = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
const png = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const gif87 = pad(Buffer.from("GIF87a", "latin1"));
const gif89 = pad(Buffer.from("GIF89a", "latin1"));

function riff(fourCc: string): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(56, 4);
  buffer.write(fourCc, 8, "latin1");
  return buffer;
}

function isoBmff(major: string, compatible: readonly string[]): Buffer {
  const size = 16 + compatible.length * 4;
  const buffer = Buffer.alloc(Math.max(64, size));
  buffer.writeUInt32BE(size, 0);
  buffer.write("ftyp", 4, "latin1");
  buffer.write(major, 8, "latin1");
  buffer.writeUInt32BE(0, 12);
  compatible.forEach((brand, index) => buffer.write(brand, 16 + index * 4, "latin1"));
  return buffer;
}

const webp = riff("WEBP");
const heic = isoBmff("heic", ["mif1", "heic"]);
const avif = isoBmff("avif", ["mif1", "miaf"]);
const heifWithAvifCompatible = isoBmff("mif1", ["mif1", "avif"]);

describe("sniffImageMediaType", () => {
  it("identifies every supported raster format from its magic bytes", () => {
    expect(sniffImageMediaType(jpeg)).toBe("image/jpeg");
    expect(sniffImageMediaType(png)).toBe("image/png");
    expect(sniffImageMediaType(gif87)).toBe("image/gif");
    expect(sniffImageMediaType(gif89)).toBe("image/gif");
    expect(sniffImageMediaType(webp)).toBe("image/webp");
    expect(sniffImageMediaType(heic)).toBe("image/heic");
  });

  it("rejects AVIF explicitly so it is never mistaken for some HEIF", () => {
    expect(sniffImageMediaType(avif)).toBeNull();
    expect(sniffImageMediaType(heifWithAvifCompatible)).toBeNull();
  });

  it("rejects a RIFF container that is not WebP", () => {
    expect(sniffImageMediaType(riff("WAVE"))).toBeNull();
  });

  it("recognizes SVG behind a BOM, XML declaration, comment, or DOCTYPE", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const cases = [
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "  \n\t<SVG xmlns='x'/>",
      "<?xml version='1.0'?><svg/>",
      "<!-- a comment --><svg/>",
      "<?xml version='1.0'?>\n<!DOCTYPE svg PUBLIC '-//W3C//DTD SVG 1.1//EN' 'x.dtd'>\n<svg/>",
    ];
    for (const source of cases) {
      expect(sniffImageMediaType(Buffer.from(source, "utf8"))).toBe("image/svg+xml");
      expect(sniffImageMediaType(Buffer.concat([bom, Buffer.from(source, "utf8")]))).toBe(
        "image/svg+xml",
      );
    }
  });

  it("returns null for markup, scripts, and unterminated prologues", () => {
    for (const source of [
      "<html><body><svg/></body></html>",
      "<?php system($_GET['c']); ?>",
      "<!-- never closed <svg/>",
      "<?xml version='1.0'",
      "<!DOCTYPE html",
      "not markup at all",
      "",
    ]) {
      expect(sniffImageMediaType(Buffer.from(source, "utf8"))).toBeNull();
    }
  });

  it("returns null for truncated headers rather than guessing", () => {
    expect(sniffImageMediaType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageMediaType(Buffer.from("GIF8", "latin1"))).toBeNull();
    expect(sniffImageMediaType(Buffer.from("RIFF0000WEB", "latin1"))).toBeNull();
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeNull();
  });

  it("lets the sniffed value win over every declared type in the spoof matrix", () => {
    const actual: readonly (readonly [Buffer, SniffedImageType | null])[] = [
      [jpeg, "image/jpeg"],
      [png, "image/png"],
      [gif89, "image/gif"],
      [webp, "image/webp"],
      [heic, "image/heic"],
      [Buffer.from("<svg/>", "utf8"), "image/svg+xml"],
      [Buffer.from("<?php echo 1; ?>", "utf8"), null],
      [Buffer.from("<html><img src=x onerror=alert(1)></html>", "utf8"), null],
      [avif, null],
    ];
    const declared = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
    ];
    for (const [bytes, expected] of actual) {
      // The declared header is never consulted; only the bytes decide.
      const sniffed = sniffImageMediaType(bytes);
      expect(sniffed).toBe(expected);
      for (const claimed of declared.filter((value) => value !== expected)) {
        expect(sniffed).not.toBe(claimed);
      }
    }
  });
});
