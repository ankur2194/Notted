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
 * `eslint-plugin-jsx-a11y` for accessibility on JSX/TSX files, plus the
 * Next.js core-web-vitals rules scoped to apps/web. NestJS-aware rules are
 * scoped to apps/api without scaffolding the application assigned to Part 5.
 * `eslint-config-prettier` is applied last so formatting stays the
 * responsibility of Prettier, not ESLint.
 */
import nestjs from "@darraghor/eslint-plugin-nestjs-typed";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import prettierConfig from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

// Config/tooling files that are not part of the TS program (not in any
// tsconfig include). Excluded from the type-aware NestJS block so the project
// service and type-aware rules do not try to process them — they are handled
// by the dedicated vitest-config block below instead.
const apiConfigIgnores = ["apps/api/vitest.config.*", "apps/api/vitest.setup.*"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/next.config.*",
      "**/postcss.config.*",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node.js globals for scripts and config files
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "*.config.mjs", "*.config.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        global: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },

  // The plugin's flat configs do not include file globs. Restrict each layer to
  // the API boundary so its parser and NestJS rules cannot leak into apps/web
  // or shared packages.
  ...nestjs.configs.flatRecommended.map((config) => ({
    ...config,
    files: ["apps/api/**/*.ts"],
    ignores: apiConfigIgnores,
  })),
  {
    files: ["apps/api/**/*.ts"],
    ignores: apiConfigIgnores,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // OpenAPI is introduced with the public REST surface in Part 65. Phase 1
      // health/scaffold routes must not pull Swagger into the runtime early.
      "@darraghor/nestjs-typed/controllers-should-supply-api-tags": "off",
      "@darraghor/nestjs-typed/api-method-should-specify-api-response": "off",
      // The rule's default src glob ("src/**/*.ts") resolves relative to the
      // monorepo root, not apps/api. Point it at the API source tree so module
      // references are discovered correctly.
      "@darraghor/nestjs-typed/injectable-should-be-provided": [
        "error",
        {
          src: ["apps/api/src/**/*.ts"],
          filterFromPaths: ["dist", "node_modules", ".test.", ".spec."],
        },
      ],
    },
  },

  // Vitest config files need vitest globals (describe, it, expect, vi, etc.)
  // and must opt out of the type-aware project service since they are not in tsconfig.
  {
    files: ["**/vitest.config.*", "**/vitest.setup.*"],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        vi: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        jest: "readonly",
      },
    },
  },

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

  // The standalone official plugin avoids installing the Next.js framework
  // before Part 4 while still enforcing its recommended Core Web Vitals rules.
  // Scope it so Next.js rules never leak into the API or shared packages.
  {
    ...nextPlugin.configs["core-web-vitals"],
    files: ["apps/web/**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      ...nextPlugin.configs["core-web-vitals"].rules,
      // Notted uses the App Router; probing for a legacy pages directory emits
      // a false diagnostic before the Part 4 scaffold exists.
      "@next/next/no-html-link-for-pages": "off",
    },
  },

  // Disable stylistic rules that conflict with Prettier. Must come last.
  prettierConfig,
);
