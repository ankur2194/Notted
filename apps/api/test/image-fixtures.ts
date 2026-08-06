// Part 41: image fixtures GENERATED AT TEST TIME. No binary is committed.
//
// Plan.md's Verify clause asks for "fixture images for every supported format".
// This generator IS that matrix: every raster fixture is produced by Sharp from
// a deterministic raw RGB(A) buffer, so the suite carries no opaque blobs a
// reviewer cannot read, nothing to keep in sync with Git LFS, and no licence
// question about a sample photograph.
//
// It lives under `test/` rather than `src/`, so `vitest.config.ts`'s
// `coverage.include: ["src/**/*.ts"]` never counts a fixture builder as
// production code that needs covering.
//
// HEIC IS THE ONE FORMAT THAT CANNOT BE GENERATED HERE. The prebuilt libvips
// Sharp ships has no HEVC *encoder* either (its `heif` output is AVIF only), and
// a real HEIC sample is patent-encumbered, so committing one is not an option.
// HEIC is therefore covered three ways, none of which needs a sample file:
//   (a) `heic-decoder.test.ts` stubs the converter and proves the routing,
//       the byte cap, the timeout, and the decoder-unavailable path;
//   (b) `image-signature.test.ts` (Part 40) proves ISO-BMFF `ftyp` sniffing from
//       a hand-built box;
//   (c) `attachments-image-processing.integration.test.ts` skips with an
//       explicit message unless `NOTTED_TEST_HEIC_FIXTURE` points at a real file.
// A real HEIC round trip is manual-verification-only. That is recorded.

import { readFileSync } from "node:fs";

import sharp from "sharp";

import type { Sharp } from "sharp";

/** Deterministic, non-uniform pixel data so encoders cannot collapse it to nothing. */
function rawPixels(width: number, height: number, channels: 3 | 4): Buffer {
  const buffer = Buffer.alloc(width * height * channels);
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = (index * 37 + (index % 11) * 13) % 256;
  }
  return buffer;
}

function source(width: number, height: number, channels: 3 | 4 = 3): Sharp {
  return sharp(rawPixels(width, height, channels), { raw: { width, height, channels } });
}

export interface RasterFixture {
  readonly name: string;
  readonly mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly pages: number;
  readonly hasAlpha: boolean;
}

export async function jpegFixture(width = 1_000, height = 333): Promise<RasterFixture> {
  return {
    name: "jpeg",
    mimeType: "image/jpeg",
    bytes: await source(width, height).jpeg({ quality: 90 }).toBuffer(),
    width,
    height,
    pages: 1,
    hasAlpha: false,
  };
}

/**
 * A JPEG carrying EXIF **including GPS**, so "metadata is stripped" is a real
 * assertion rather than a tautology on an image that never had any.
 */
export async function jpegWithGpsFixture(width = 400, height = 300): Promise<RasterFixture> {
  // `IFD3` IS the GPS IFD in libvips — sharp's `Exif` interface exposes only
  // IFD0-IFD3 and has no `GPS` key. Verified on the pinned sharp: the `IFD3`
  // key writes the GPS IFD pointer (tag 0x8825) plus GPS tags 0x1/0x2/0x3,
  // while a `GPS` key is silently dropped and leaves the fixture with no GPS
  // at all. Naming it `GPS` here would make the "removes GPS" assertion in
  // `image-processing.service.test.ts` permanently vacuous.
  const bytes = await source(width, height)
    .withExif({
      IFD0: { Copyright: "notted-fixture", Software: "notted-test" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W" },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
  return {
    name: "jpeg-gps",
    mimeType: "image/jpeg",
    bytes,
    width,
    height,
    pages: 1,
    hasAlpha: false,
  };
}

/** Opaque PNG — `full` becomes JPEG because nothing needs an alpha channel. */
export async function pngFixture(width = 600, height = 400): Promise<RasterFixture> {
  return {
    name: "png",
    mimeType: "image/png",
    bytes: await source(width, height).png().toBuffer(),
    width,
    height,
    pages: 1,
    hasAlpha: false,
  };
}

/** PNG WITH transparency — `full` must stay PNG or the alpha is destroyed. */
export async function alphaPngFixture(width = 120, height = 80): Promise<RasterFixture> {
  return {
    name: "png-alpha",
    mimeType: "image/png",
    bytes: await source(width, height, 4).png().toBuffer(),
    width,
    height,
    pages: 1,
    hasAlpha: true,
  };
}

export async function webpFixture(width = 300, height = 200): Promise<RasterFixture> {
  return {
    name: "webp",
    mimeType: "image/webp",
    bytes: await source(width, height).webp().toBuffer(),
    width,
    height,
    pages: 1,
    hasAlpha: false,
  };
}

export async function staticGifFixture(width = 240, height = 160): Promise<RasterFixture> {
  return {
    name: "gif-static",
    mimeType: "image/gif",
    bytes: await source(width, height).gif().toBuffer(),
    width,
    height,
    pages: 1,
    hasAlpha: false,
  };
}

/**
 * A genuinely animated GIF. Sharp's `join: { animated: true }` stacks the frames
 * into the filmstrip layout libvips uses for animation, which is the only way to
 * build one without committing a binary or hand-writing LZW.
 */
export async function animatedGifFixture(size = 64, frames = 3): Promise<RasterFixture> {
  const pages: Buffer[] = [];
  for (let index = 0; index < frames; index += 1) {
    // Vary each frame so a first-frame-only rendition is distinguishable.
    pages.push(
      await source(size, size)
        .modulate({ brightness: 1 + index * 0.2 })
        .png()
        .toBuffer(),
    );
  }
  return {
    name: "gif-animated",
    mimeType: "image/gif",
    bytes: await sharp(pages, { join: { animated: true } })
      .gif()
      .toBuffer(),
    width: size,
    height: size,
    pages: frames,
    hasAlpha: false,
  };
}

/** Animated WebP, handled exactly like an animated GIF. */
export async function animatedWebpFixture(size = 64, frames = 3): Promise<RasterFixture> {
  const pages: Buffer[] = [];
  for (let index = 0; index < frames; index += 1) {
    pages.push(
      await source(size, size)
        .modulate({ brightness: 1 + index * 0.2 })
        .png()
        .toBuffer(),
    );
  }
  return {
    name: "webp-animated",
    mimeType: "image/webp",
    bytes: await sharp(pages, { join: { animated: true } })
      .webp()
      .toBuffer(),
    width: size,
    height: size,
    pages: frames,
    hasAlpha: false,
  };
}

/** Every raster fixture, for the "expected variants for every format" matrix. */
export async function allRasterFixtures(): Promise<readonly RasterFixture[]> {
  return [
    await jpegFixture(),
    await pngFixture(),
    await alphaPngFixture(),
    await webpFixture(),
    await staticGifFixture(),
    await animatedGifFixture(),
    await animatedWebpFixture(),
  ];
}

// --------------------------------------------------------------------- //
// SVG — literal UTF-8, because the point is the SOURCE TEXT, not the pixels
// --------------------------------------------------------------------- //

export const SAFE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <rect width="200" height="100" fill="#3366ff"/>
  <circle cx="50" cy="50" r="30" fill="#ffcc00"/>
  <use href="#nothing"/>
</svg>`;

/** Hostile sources, each isolating one rejection class. */
export const HOSTILE_SVGS = Object.freeze({
  script: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>fetch("//evil.example")</script></svg>`,
  foreignObject: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>`,
  // The SAME two vectors spelled with a namespace prefix. XML lets a document
  // bind the SVG namespace to any prefix it likes, so `<svg:script>` is the
  // identical element to `<script>` — an unprefixed-only scan would wave it past
  // while still claiming to cover the vector.
  prefixedScript: `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10" height="10"><svg:script>fetch("//evil.example")</svg:script></svg:svg>`,
  prefixedForeignObject: `<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml">x</body></s:foreignObject></s:svg>`,
  entity: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&lol2;</text></svg>`,
  externalImage: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="http://169.254.169.254/latest/meta-data/" width="10" height="10"/></svg>`,
  externalUse: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><use href="https://evil.example/payload.svg#x"/></svg>`,
  fileXlink: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="file:///etc/passwd" width="10" height="10"/></svg>`,
  svgDataXlink: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="data:image/svg+xml;base64,PHN2Zy8+" width="10" height="10"/></svg>`,
} as const);

/** A safe SVG whose only reference is an allowed inline raster data URI. */
export const SVG_WITH_DATA_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20"><image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="20" height="20"/></svg>`;

/** Larger than any configured `MAX_SVG_SOURCE_BYTES` default. */
export function oversizedSvg(bytes = 3 * 1_024 * 1_024): Buffer {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- `;
  const tail = ` --><rect width="10" height="10"/></svg>`;
  const padding = "a".repeat(Math.max(0, bytes - head.length - tail.length));
  return Buffer.from(`${head}${padding}${tail}`, "utf8");
}

/**
 * A source engineered to make a badly written prescan backtrack: long runs of
 * quote and equals characters that look like the start of an attribute over and
 * over. Used with a wall-clock budget, because a scanner that can be made to
 * backtrack IS the denial of service it was added to prevent.
 */
export function pathologicalSvg(repeat = 20_000): Buffer {
  const noise = ` href=`.repeat(repeat);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect${noise}/></svg>`,
    "utf8",
  );
}

// --------------------------------------------------------------------- //
// Malformed input
// --------------------------------------------------------------------- //

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function pngCrc(chunk: Buffer): number {
  let crc = -1;
  for (const byte of chunk) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * THE DECOMPRESSION BOMB: ~90 bytes of valid PNG whose IHDR declares
 * 65535 x 65535 (4.29 gigapixels, ~12 GiB decoded). The CRC is correct, so the
 * header parses cleanly and the rejection has to come from a pixel budget rather
 * than from the file being malformed.
 */
export function decompressionBombPng(width = 65_535, height = 65_535): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Valid SOI and header, garbage tail — proves `failOn: "warning"` bites. */
export async function truncatedJpeg(): Promise<Buffer> {
  const complete = (await jpegFixture(800, 600)).bytes;
  return Buffer.concat([
    complete.subarray(0, Math.floor(complete.length / 2)),
    Buffer.alloc(64, 0x41),
  ]);
}

/** Not an image at all, but long enough to reach a decoder. */
export function garbageBytes(size = 4_096): Buffer {
  return Buffer.alloc(size, 0x5a);
}

// --------------------------------------------------------------------- //
// HEIC
// --------------------------------------------------------------------- //

export const HEIC_FIXTURE_ENV = "NOTTED_TEST_HEIC_FIXTURE";

/** A real HEIC file, only when an operator supplied one. */
export function heicFixtureFromEnvironment(): Buffer | null {
  const path = process.env[HEIC_FIXTURE_ENV];
  if (typeof path !== "string" || path.trim() === "") return null;
  try {
    return readFileSync(path.trim());
  } catch {
    return null;
  }
}

/**
 * A syntactically valid ISO-BMFF `ftyp` box with a HEIC brand and no payload.
 * Enough for the Part 40 sniffer, never enough for a decoder — which is exactly
 * what makes it useful for proving the ROUTING without a real sample.
 */
export function heicFtypHeader(): Buffer {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(24, 0);
  box.write("ftyp", 4, "latin1");
  box.write("heic", 8, "latin1");
  box.writeUInt32BE(0, 12);
  box.write("mif1", 16, "latin1");
  box.write("heic", 20, "latin1");
  return box;
}
