/**
 * Fixed, contract-valid colour palettes for the editor toolbar.
 *
 * The shared document contract only accepts `#rrggbb` values, so the toolbar
 * offers a bounded swatch set instead of a free-form picker. Every value here
 * is validated again before it is applied, so an invalid colour can never reach
 * the persisted document even if this table is edited carelessly.
 */

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export interface EditorColorOption {
  readonly value: string;
  readonly label: string;
}

/** Text colours chosen for at least 4.5:1 contrast on the white note page. */
export const NOTE_TEXT_COLORS: readonly EditorColorOption[] = Object.freeze([
  { value: "#0f172a", label: "Ink" },
  { value: "#475569", label: "Slate" },
  { value: "#b91c1c", label: "Red" },
  { value: "#c2410c", label: "Orange" },
  { value: "#a16207", label: "Amber" },
  { value: "#15803d", label: "Green" },
  { value: "#0f766e", label: "Teal" },
  { value: "#1d4ed8", label: "Blue" },
  { value: "#6d28d9", label: "Violet" },
  { value: "#be185d", label: "Pink" },
]);

/** Highlight colours chosen to keep dark body text readable on top of them. */
export const NOTE_HIGHLIGHT_COLORS: readonly EditorColorOption[] = Object.freeze([
  { value: "#fef08a", label: "Yellow" },
  { value: "#fed7aa", label: "Orange" },
  { value: "#bbf7d0", label: "Green" },
  { value: "#bfdbfe", label: "Blue" },
  { value: "#e9d5ff", label: "Purple" },
  { value: "#fbcfe8", label: "Pink" },
  { value: "#e2e8f0", label: "Grey" },
]);

const ALLOWED_COLORS: ReadonlySet<string> = new Set([
  ...NOTE_TEXT_COLORS.map((option) => option.value),
  ...NOTE_HIGHLIGHT_COLORS.map((option) => option.value),
]);

/** Deny by default: only palette values that are also valid `#rrggbb` pass. */
export function isAllowedEditorColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) && ALLOWED_COLORS.has(value);
}

const RGB_PATTERN =
  /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+\s*)?\)$/i;

/**
 * Normalise a CSS colour read from pasted HTML to the contract's `#rrggbb`, or
 * `null` (drop the colour, keep the text) when it cannot be expressed.
 *
 * Browsers serialise `element.style.color` as `rgb(r, g, b)` even when the
 * markup said `#1d4ed8`, so TipTap's stock `parseHTML` hands the document an
 * `rgb(...)` value the shared contract refuses. In a collaborative session that
 * refusal happens on the API's projection, silently and forever: the note stays
 * editable but `notes.content` — public link, export, search — never updates.
 */
export function cssColorToHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (HEX_COLOR_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${[...trimmed.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
  }
  const match = RGB_PATTERN.exec(trimmed);
  if (match === null) return null;
  const channels = match.slice(1, 4).map(Number);
  if (channels.some((channel) => channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
