// Part 40: first-party magic-byte sniffing.
//
// Why not `file-type`: the published `file-type@21.x` (and its `strtok3` /
// `token-types` dependencies) are ESM-only with an exports map. `apps/api`
// compiles with `module: CommonJS` + `moduleResolution: Node10`, so TypeScript
// cannot resolve it and a dynamic `import()` downlevels to `require()`. The
// supported surface here is six image formats, so a reviewed 150-line sniffer
// is smaller, auditable, and has no runtime dependency.
//
// TRUST RULE (ADR 0005): the value returned here is authoritative and is what
// lands in `attachments.mime_type`. The multipart part's `Content-Type` header
// and the filename extension are read for display only and are NEVER trusted
// and NEVER persisted as the type.

export const SNIFFED_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
] as const);

export type SniffedImageType = (typeof SNIFFED_IMAGE_TYPES)[number];

/** Bytes of the head that are examined. Enough for ISO-BMFF brands and an XML prologue. */
export const IMAGE_SIGNATURE_HEAD_BYTES = 1_024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** ISO-BMFF brands that denote a HEIF/HEIC still image. */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/**
 * AVIF shares the ISO-BMFF container and the `mif1`/`msf1` compatible brands
 * with HEIF. It is matched FIRST and rejected explicitly so it can never be
 * mistaken for "some HEIF" and handed to a decoder that cannot read it.
 */
const AVIF_BRANDS = new Set(["avif", "avis", "avio"]);

function brandAt(head: Buffer, offset: number): string | null {
  if (head.length < offset + 4) return null;
  return head.toString("latin1", offset, offset + 4);
}

function sniffIsoBaseMedia(head: Buffer): SniffedImageType | null {
  if (brandAt(head, 4) !== "ftyp") return null;
  const majorBrand = brandAt(head, 8);
  if (majorBrand === null) return null;
  if (AVIF_BRANDS.has(majorBrand)) return null;

  // `compatible_brands` runs from offset 16 to the end of the `ftyp` box.
  const boxSize = head.readUInt32BE(0);
  const limit = Math.min(head.length, boxSize > 0 ? boxSize : head.length);
  const compatible: string[] = [];
  for (let offset = 16; offset + 4 <= limit; offset += 4) {
    const brand = brandAt(head, offset);
    if (brand === null) break;
    compatible.push(brand);
  }
  if (compatible.some((brand) => AVIF_BRANDS.has(brand))) return null;
  if (HEIF_BRANDS.has(majorBrand)) return "image/heic";
  return null;
}

function stripByteOrderMark(head: Buffer): Buffer {
  return head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
    ? head.subarray(3)
    : head;
}

/**
 * Skip whitespace, XML declarations, comments, and DOCTYPE prologues, then look
 * for a root `<svg` element. Bounded to the first kibibyte so a crafted file
 * cannot force an unbounded scan.
 */
function sniffSvg(head: Buffer): SniffedImageType | null {
  const text = stripByteOrderMark(head).toString("utf8", 0, IMAGE_SIGNATURE_HEAD_BYTES);
  let index = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    while (index < text.length && /\s/u.test(text[index] as string)) index += 1;
    if (index >= text.length) return null;
    if (text.startsWith("<?", index)) {
      const end = text.indexOf("?>", index + 2);
      if (end === -1) return null;
      index = end + 2;
      continue;
    }
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end === -1) return null;
      index = end + 3;
      continue;
    }
    if (text.startsWith("<!", index)) {
      const end = text.indexOf(">", index + 2);
      if (end === -1) return null;
      index = end + 1;
      continue;
    }
    return text.slice(index, index + 4).toLowerCase() === "<svg" ? "image/svg+xml" : null;
  }
  return null;
}

/**
 * Identify an image from its leading bytes, or `null` when the head does not
 * match a supported format (including truncated heads and AVIF).
 */
export function sniffImageMediaType(head: Buffer): SniffedImageType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (head.length >= 3 && head.subarray(0, 3).equals(JPEG_SIGNATURE)) return "image/jpeg";
  if (head.length >= 6) {
    const magic = head.toString("latin1", 0, 6);
    if (magic === "GIF87a" || magic === "GIF89a") return "image/gif";
  }
  if (head.length >= 12 && brandAt(head, 0) === "RIFF" && brandAt(head, 8) === "WEBP") {
    return "image/webp";
  }
  if (head.length >= 12) {
    const isoBaseMedia = sniffIsoBaseMedia(head);
    if (isoBaseMedia !== null) return isoBaseMedia;
  }
  return sniffSvg(head);
}
