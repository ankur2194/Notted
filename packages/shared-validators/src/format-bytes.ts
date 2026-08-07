/**
 * One human-readable byte formatter for the whole product (Part 44).
 *
 * It lives here, in the package both apps depend on, because there are now three
 * independent callers and a second implementation would drift immediately:
 *
 * - `renderDocumentHtml`'s attachment card, which is what prints and exports;
 * - the editor's attachment node view, which is what a reader sees on screen;
 * - the workspace storage limit in settings (and Part 45's usage display).
 *
 * Binary units, because storage quotas, object sizes, and `MAX_UPLOAD_SIZE_BYTES`
 * are all expressed as powers of two, and showing "52.4 MB" next to a limit
 * written as `50 * 1024 * 1024` reads as a bug.
 *
 * `Intl.NumberFormat` is fixed to the `en` locale deliberately: the value is
 * rendered into stored HTML by the document renderer, which runs server-side
 * during export with no reader locale available, so a locale-dependent decimal
 * separator would make the same document render differently in two places.
 */

const BINARY_UNITS = Object.freeze(["KiB", "MiB", "GiB", "TiB", "PiB"] as const);

const DECIMAL_FORMAT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const INTEGER_FORMAT = new Intl.NumberFormat("en");

/**
 * A concise binary size such as `1.19 MiB`.
 *
 * Values below 1 KiB are shown as exact bytes; anything not a finite,
 * non-negative number is treated as `0` rather than emitting `NaN` into a
 * document projection.
 */
export function formatBinaryBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (safe < 1_024) return `${safe} B`;

  let value = safe;
  let unitIndex = -1;
  while (value >= 1_024 && unitIndex < BINARY_UNITS.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${DECIMAL_FORMAT.format(value)} ${BINARY_UNITS[unitIndex] ?? "PiB"}`;
}

/**
 * The exact byte count, grouped for readability.
 *
 * Paired with {@link formatBinaryBytes} wherever a size is shown: the concise
 * form is marked `aria-hidden` and this one goes in a visually hidden span, so
 * assistive technology reads the precise number rather than a rounded one.
 */
export function exactByteLabel(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  return `${INTEGER_FORMAT.format(safe)} bytes`;
}
