import { Extension } from "@tiptap/core";
import "@tiptap/extension-text-style";

export const NOTE_FONT_SIZES = [
  "8px",
  "9px",
  "10px",
  "11px",
  "12px",
  "14px",
  "16px",
  "18px",
  "20px",
  "24px",
  "28px",
  "32px",
  "36px",
  "48px",
  "72px",
] as const;

export type NoteFontSize = (typeof NOTE_FONT_SIZES)[number];

const NOTE_FONT_SIZE_SET: ReadonlySet<string> = new Set(NOTE_FONT_SIZES);

export function isAllowedNoteFontSize(value: unknown): value is NoteFontSize {
  return typeof value === "string" && NOTE_FONT_SIZE_SET.has(value);
}

function allowedFontSizeOrNull(value: unknown): NoteFontSize | null {
  return isAllowedNoteFontSize(value) ? value : null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (fontSize: NoteFontSize) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

export const FontSize = Extension.create({
  name: "fontSize",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => allowedFontSizeOrNull(element.style.fontSize),
            renderHTML: (attributes: Record<string, unknown>) => {
              const fontSize = allowedFontSizeOrNull(attributes.fontSize);
              return fontSize === null ? {} : { style: `font-size: ${fontSize}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (fontSize) =>
        ({ chain }) => {
          if (!isAllowedNoteFontSize(fontSize)) return false;
          return chain().setMark("textStyle", { fontSize }).run();
        },
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});
