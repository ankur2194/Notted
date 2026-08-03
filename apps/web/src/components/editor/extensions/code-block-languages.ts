import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

import type { NoteDocumentCodeLanguage } from "@notted/shared-validators";
import type { LanguageFn } from "highlight.js";

/**
 * Syntax-highlighting registry for note code blocks.
 *
 * Keying this record by `NoteDocumentCodeLanguage` makes the compiler enforce
 * that it holds exactly the languages the shared document contract allows: a
 * language the editor can produce is always one the backend accepts and the
 * highlighter can render. `lowlight`'s `all` and `common` bundles are
 * deliberately not used — they would pull hundreds of grammars into the client
 * bundle for languages the contract rejects anyway.
 */
const LANGUAGE_GRAMMARS: Readonly<Record<NoteDocumentCodeLanguage, LanguageFn>> = {
  bash,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};

export interface CodeBlockLanguageOption {
  readonly value: NoteDocumentCodeLanguage;
  readonly label: string;
}

/** Human-readable names for the language selector, in the order shown. */
export const CODE_BLOCK_LANGUAGE_OPTIONS: readonly CodeBlockLanguageOption[] = Object.freeze(
  (
    [
      ["bash", "Bash"],
      ["css", "CSS"],
      ["go", "Go"],
      ["java", "Java"],
      ["javascript", "JavaScript"],
      ["json", "JSON"],
      ["markdown", "Markdown"],
      ["python", "Python"],
      ["rust", "Rust"],
      ["shell", "Shell"],
      ["sql", "SQL"],
      ["typescript", "TypeScript"],
      ["xml", "HTML / XML"],
      ["yaml", "YAML"],
    ] as const satisfies readonly (readonly [NoteDocumentCodeLanguage, string])[]
  ).map(([value, label]) => ({ value, label })),
);

/**
 * Build a lowlight instance carrying only the registered grammars. A fresh
 * instance per editor keeps two editors on one page from sharing mutable
 * highlighter state.
 */
export function createNoteLowlight(): ReturnType<typeof createLowlight> {
  const lowlight = createLowlight();
  for (const [language, grammar] of Object.entries(LANGUAGE_GRAMMARS)) {
    lowlight.register(language, grammar);
  }
  return lowlight;
}
