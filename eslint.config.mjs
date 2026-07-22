/**
 * Notted shared ESLint flat configuration (Part 3).
 *
 * Applies to every workspace (apps/web, apps/api, packages/*) because ESLint
 * discovers this file by walking up from the linted file's directory. Each
 * workspace's `lint` script runs `eslint . --max-warnings 0` so warnings fail
 * the build in CI exactly as errors do.
 *
 * Scope decision: this is the framework-neutral foundation. It layers
 * `@eslint/js`, `typescript-eslint` (non-type-checked recommended set, so lint
 * stays fast and does not require the TS program/project service on scaffold
 * apps), `eslint-plugin-import-x` for import ordering, and
 * `eslint-plugin-jsx-a11y` for accessibility on JSX/TSX files. The
 * Next.js-specific (`eslint-config-next` / `@next/eslint-plugin`) and
 * NestJS-specific (`eslint-plugin-nestjs`) rule sets require those frameworks
 * to be installed and to satisfy strict peer resolution (ADR 0008); they are
 * therefore layered in by Part 4 (apps/web) and Part 5 (apps/api) respectively
 * rather than pulled in here. `eslint-config-prettier` is applied last so
 * formatting stays the responsibility of Prettier, not ESLint.
 */
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/.turbo/**", "**/node_modules/**", "**/coverage/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Import ordering and duplicate-import hygiene. These rules are syntactic and
  // do not require an import resolver, so no resolver dependency is introduced.
  {
    plugins: { "import-x": importX },
    rules: {
      "import-x/order": [
        "error",
        {
          "newlines-between": "always",
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import-x/no-duplicates": "error",
      "import-x/no-mutable-exports": "error",
    },
  },

  // Accessibility rules apply only to JSX/TSX (Part 4 introduces React). There
  // is no JSX in the repository yet, so this block is foundational and inert
  // until then.
  {
    files: ["**/*.{jsx,tsx}"],
    ...jsxA11y.flatConfigs.recommended,
  },

  // Disable stylistic rules that conflict with Prettier. Must come last.
  prettierConfig,
);
