/**
 * Server-only entrypoint (`@notted/shared-validators/server`) — deliberately
 * NOT re-exported from the package's main barrel (`./index.ts`). The main
 * barrel is `transpilePackages`-loaded into `apps/web`'s client bundles by
 * ~30 `"use client"` components (Zod schemas, `renderDocumentHtml`, …),
 * `TiptapEditor` among them. `createRequire`, below, is a Node-only API
 * evaluated at MODULE LOAD TIME, not lazily — unlike `readFileSync`, which
 * only runs on first call. Putting it anywhere reachable from that barrel
 * would mean every such client component's bundle eagerly evaluates a
 * Node-only API on init, at the mercy of the bundler's dead-code elimination
 * actually proving it unreachable. This subpath makes that unnecessary: only
 * modules that import `@notted/shared-validators/server` explicitly — today,
 * `apps/api/src/export/export-html.ts` and
 * `apps/web/src/app/p/[token]/page.tsx`, both server-only — ever reach this
 * file at all, so there is nothing for a bundler to eliminate correctly in
 * the first place.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireFrom = createRequire(__filename);

let cachedPrintStylesheet: string | null = null;

/**
 * The verbatim contents of `@notted/shared-validators/print.css`, read once
 * and memoized. Resolved through the package's own `exports` map (Node's
 * self-referencing packages feature — this module lives inside
 * `@notted/shared-validators` itself, so it resolves its own subpath rather
 * than a raw relative path). Only the file read is lazy (first call only);
 * `createRequire(__filename)` above runs at import time. Importing this
 * module never touches the *filesystem* by itself, but it does evaluate a
 * Node-only API — which is exactly why this function lives in this
 * dedicated server-only subpath rather than the main package barrel.
 */
export function printStylesheet(): string {
  if (cachedPrintStylesheet === null) {
    const resolved = requireFrom.resolve("@notted/shared-validators/print.css");
    cachedPrintStylesheet = readFileSync(resolved, "utf8");
  }
  return cachedPrintStylesheet;
}
