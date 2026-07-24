import nestjs from "@darraghor/eslint-plugin-nestjs-typed";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const config = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nestjs.configs.flatRecommended.map((config) => ({
    ...config,
    files: ["apps/api/**/*.ts"],
    ignores: ["apps/api/vitest.config.*"],
  })),
  {
    files: ["apps/api/**/*.ts"],
    ignores: ["apps/api/vitest.config.*"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@darraghor/nestjs-typed/controllers-should-supply-api-tags": "off",
      "@darraghor/nestjs-typed/api-method-should-specify-api-response": "off",
      "@darraghor/nestjs-typed/injectable-should-be-provided": [
        "error",
        {
          src: ["apps/api/src/**/*.ts"],
          filterFromPaths: ["dist", "node_modules", ".test.", ".spec."],
        },
      ],
    },
  },
  {
    files: ["**/vitest.config.*"],
    languageOptions: { parserOptions: { projectService: false } },
  },
);
export default config;
