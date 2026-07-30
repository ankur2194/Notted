import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    globals: true,
    css: true,
    // WSL/CI environments can time out while over-provisioning fork workers.
    // Four workers preserve file-level parallelism without exhausting process
    // startup resources.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/app/layout.tsx"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Next.js replaces these bare specifiers at build time to enforce its
      // server/client boundary; Vitest does not, so resolve them to an empty
      // stub here. This alias is test-only and never reaches the Next.js build.
      "server-only": path.resolve(__dirname, "./src/test/stubs/empty.ts"),
      "client-only": path.resolve(__dirname, "./src/test/stubs/empty.ts"),
    },
  },
});
