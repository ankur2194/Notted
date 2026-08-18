# Part 03 — Establish formatting, linting, and commit quality gates

## Status

- **State:** Complete
- **Completed on:** 2026-07-23
- **Implemented by:** `lead-part-engineer` (Part 3) with an independent `quality-reviewer` pass
- **Plan reference:** `Plan.md`, Part 3
- **Related records:** `part-02-monorepo-initialization.md`; `part-01-architecture-decisions.md`; `docs/decisions/0001-monorepo-boundaries.md`; `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Replace Part 2's placeholder `lint`/`format` scripts with real, repo-wide enforcement and add the surrounding quality gates: ESLint (Next.js, NestJS, TypeScript, accessibility, import ordering, Prettier compatibility), consistent Prettier, scripts that fail on warnings, an optional but reproducible pre-commit hook, and the project coding-conventions file (`CLAUDE.md`) with the filename/component naming rules reconciled against the canonical `Notted.md` structure. Part 3 owns tooling only; its framework-aware rules are scoped to the existing app boundaries without implementing the application scaffolds owned by Parts 4 and 5.

## Implemented Work

- **ESLint 9 flat config** (`eslint.config.mjs` at repo root, discovered by every workspace via ESLint's upward config search). Layers: `@eslint/js` recommended → `typescript-eslint` recommended → `@darraghor/eslint-plugin-nestjs-typed` recommended rules with type-aware parsing scoped to `apps/api/**/*.ts` → `eslint-plugin-import-x` (`import-x/order`, `import-x/no-duplicates`, `import-x/no-mutable-exports`; no resolver dependency) → `eslint-plugin-jsx-a11y` scoped to JSX/TSX → official Next.js Core Web Vitals rules scoped to `apps/web` → `eslint-config-prettier` last so Prettier owns formatting. Ignores `dist/`, `.next/`, `.turbo/`, `node_modules/`, `coverage/`.
- **Framework-aware linting without framework scaffolds.** The standalone official `@next/eslint-plugin-next@16.2.11` enforces Next.js Core Web Vitals rules under `apps/web`; legacy Pages Router directory probing is disabled because `Notted.md` specifies App Router and Part 4 has not created it yet. `@darraghor/eslint-plugin-nestjs-typed@7.2.5` enforces NestJS-specific rules under `apps/api` using the existing API TypeScript project; only `injectable-should-be-provided` is disabled until Part 5 supplies a real Nest module graph because the rule cannot complete meaningfully against the empty scaffold.
- **Prettier** (`.prettierrc.json` + `.prettierignore`): 2-space, double quotes, semicolons, trailing comma `all`, `printWidth: 100`, LF. `.prettierignore` excludes build artifacts, `pnpm-lock.yaml`, `*.md` (`.editorconfig` already governs markdown with 4-space indent and no trailing-whitespace trimming), and agent scaffolding dirs.
- **Real per-workspace scripts** (replaced Part 2 placeholders in `apps/web`, `apps/api`, `packages/shared-types`, `packages/shared-validators`): `lint` = `eslint . --max-warnings 0`, `lint:fix` = `eslint . --fix`, `format` = `prettier --write .`, `format:check` = `prettier --check .`. The `eslint`/`prettier` binaries resolve from each workspace via pnpm's PATH augmentation to the root `node_modules/.bin` (verified), so no duplicate tool declarations are needed in workspace `devDependencies`.
- **Root aggregator scripts** (`package.json`): `lint`/`lint:fix`/`format`/`format:check` each run the turbo task across the four workspaces **and then** a root-level check (`eslint eslint.config.mjs` / `prettier --check` on the root config files). This closes the gap where root config files were outside the turbo gate. Confirmed `turbo run <task>` excludes the root package (no recursion).
- **Turborepo** (`turbo.json`): added `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore` to `globalDependencies` (config edits invalidate downstream caches); added uncached `lint:fix` and `format` tasks and a cached `format:check` task; `lint` inputs now include `tsconfig*.json`.
- **Pre-commit hook** (husky v9 + lint-staged): `.husky/pre-commit` runs `pnpm lint-staged`; `.lintstagedrc.json` runs `eslint --fix` then `prettier --write` on staged JS/TS/JSX/TSX and `prettier --write` on staged JSON/YAML. husky's `core.hooksPath=.husky/_`; the internal `.husky/_/` is gitignored (`*`) so only `.husky/pre-commit` is tracked. `prepare: husky` wires hooks on `pnpm install`; `HUSKY=0` skips hooks entirely (verified), and `git commit --no-verify` skips locally. The checks are always reproducible via `pnpm lint`/`pnpm format`.
- **Coding-conventions file** (`CLAUDE.md`): rewritten to reconcile the brief's naming contradiction against the canonical `Notted.md` structure — PascalCase React component files (`NoteCard.tsx`, `TiptapEditor.tsx`), kebab-case non-component source (`workspaces.service.ts`, `auth.schema.ts`), camelCase hook files (`useWorkspace.ts`), plus the brief's architecture/code-style/database/API/frontend/security/testing/ops guidance, deferring exact versions to ADR 0008 and boundaries to ADR 0001/0002 to prevent drift.

## Important Decisions

- **ESLint 9.39.5, not 10.** ESLint `10.7.0` is `latest`, but `eslint-plugin-jsx-a11y@6.10.2` (the current release and the standard accessibility plugin the brief requires) declares peer `eslint: ^3 || … || ^9` — it does not accept ESLint 10. ADR 0008 forbids peer overrides to conceal incompatibility, so ESLint 9.39.5 (latest 9.x, the `maintenance` tag) is the chosen baseline: it is mutually peer-compatible with `typescript-eslint@8.65.0` (`^8.57 || ^9 || ^10`), `eslint-plugin-import-x@4.17.1` (same), `eslint-plugin-jsx-a11y@6.10.2`, and `eslint-config-prettier@10.1.8` (`>=7`) under strict-peer resolution. This is a tooling compatibility pin within ADR 0008's philosophy, recorded here; it is not a major architectural boundary and does not require a new ADR. Revisit when jsx-a11y publishes an ESLint-10-compatible release.
- **Standalone framework plugins preserve Parts 4/5 boundaries.** Part 3 installs the official standalone Next.js plugin rather than the full framework/config package and a NestJS-specific ESLint plugin rather than NestJS runtime packages. This satisfies Part 3's explicit framework lint requirement while leaving application creation, framework runtime dependencies, and production builds to Parts 4 and 5.
- **Type-aware linting is limited to the API boundary.** The shared TypeScript recommended set remains syntax-based for speed, while the NestJS plugin receives `projectService: true` only for `apps/api/**/*.ts`. This prevents its parser cost and decorator rules from leaking into the web or shared packages.
- **import ordering without a resolver.** `import-x/order`, `no-duplicates`, and `no-mutable-exports` are syntactic and need no module resolver, so no `eslint-import-resolver-*` dependency is introduced. `import/no-unresolved` is intentionally omitted; a later part that enables it must install a resolver (and approve the transitive `unrs-resolver` native build script).
- **`eslint-plugin-jsx-a11y` `flatConfigs.recommended` has no `files` key**, so spreading it after `files: ["**/*.{jsx,tsx}"]` correctly scopes the 34 accessibility rules to JSX/TSX only (verified by the reviewer).
- **Root-config coverage via chained root scripts, not a turbo root task.** `turbo run <task>` excludes the root package (confirmed by `--dry=json` for `lint`, `format:check`, `format`, `lint:fix`), so the root aggregator scripts safely chain `turbo run <task> && <root check>` with zero recursion risk. An explicit root-config file list is used for Prettier because fast-glob excludes dotfiles (e.g., `.prettierrc.json`) from `*.json` patterns.
- **Pinned versions** (exact, via `.npmrc save-exact`): the original toolchain plus `@next/eslint-plugin-next@16.2.11`, `@darraghor/eslint-plugin-nestjs-typed@7.2.5`, and its direct peers `@typescript-eslint/parser@8.65.0` and `class-validator@0.14.3`. All are dev-only and add no application runtime/bundle cost. Plugin `7.2.5` is the latest evaluated NestJS lint release supporting Node 22; newer evaluated `7.2.x` releases require Node 24.

## Files and Components

| Path | Purpose |
|---|---|
| `eslint.config.mjs` | Shared ESLint 9 flat config (Next.js + NestJS + TS + import order + a11y-on-JSX + Prettier compat), with framework rules scoped to their app boundaries. |
| `.prettierrc.json` | Prettier options (2-space, double quotes, semicolons, trailing comma `all`, `printWidth: 100`, LF). |
| `.prettierignore` | Excludes build artifacts, lockfile, `*.md`, agent scaffolding from Prettier. |
| `.lintstagedrc.json` | lint-staged config: `eslint --fix` + `prettier --write` on staged JS/TS; `prettier --write` on staged JSON/YAML. |
| `.husky/pre-commit` | Runs `pnpm lint-staged` on commit. Tracked. (`.husky/_/` internals are gitignored.) |
| `package.json` | Exact root devDeps for the ESLint/Prettier/framework-plugin/husky/lint-staged toolchain; root aggregator scripts include root-config checks; `prepare: husky`. |
| `turbo.json` | `globalDependencies` extended with lint/format configs; `lint:fix`/`format` (uncached) and `format:check` tasks added. |
| `apps/{web,api}/package.json`, `packages/{shared-types,shared-validators}/package.json` | Placeholder `lint`/`format` scripts replaced with real `lint`/`lint:fix`/`format`/`format:check`. |
| `CLAUDE.md` | Reconciled AI coding conventions (naming, architecture, code style, etc.); versions deferred to ADR 0008. |
| `pnpm-lock.yaml` | Reproducible lockfile for the complete Part 3 toolchain (`lockfileVersion: '9.0'`). |

## Database and Data Changes

None. Part 3 introduces no schema, migration, seed, runtime route, port, or environment variable. The `db:*` scripts remain Part 2 placeholders (Part 12/Part 20).

## API, Configuration, and Operational Changes

- New operational scripts: `pnpm lint` (fails on any warning), `pnpm lint:fix`, `pnpm format`, `pnpm format:check`, plus the existing `pnpm type-check`/`test`/`build`. `pnpm lint`/`pnpm format:check` now cover both workspaces and root config files.
- Pre-commit hook auto-installs via `pnpm install` (`prepare: husky`). Automated environments should set `HUSKY=0` to skip hook execution and run `pnpm lint`/`pnpm format:check`/`pnpm type-check`/`pnpm test`/`pnpm build` directly.
- Defaults are safe for development; nothing runs automatically beyond the optional pre-commit hook, which is bypassable with `--no-verify`.

## Security and Tenant-Isolation Notes

No new security impact: Part 3 is developer tooling with no application code, transports, persistence, auth, or tenant data. Hygiene verified: a scoped secret scan of all new/changed files found no secrets, tokens, credentials, or personal data (the only secret-looking strings are prose words like "secrets"/"key" in `CLAUDE.md`'s security guidelines). The pre-commit hook runs only `eslint --fix`/`prettier --write` on staged files; it executes no network calls and writes no artifacts outside the working tree. husky internals are gitignored so only the reviewed `.husky/pre-commit` is tracked.

## Verification Evidence

All commands run from the repository root with Node `v22.23.1` and pnpm `10.34.5`. The `quality-reviewer` agent independently reproduced the full gate and the verify-gate direction (malformed → caught → removed → green).

| Check | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Pass | Exit 0; only a benign `unrs-resolver@1.12.2` ignored-build-script warning (native binding for import resolvers; no resolver-dependent rules are enabled, so it is never exercised). |
| `pnpm lint` | Pass | 4/4 workspace tasks + root `eslint eslint.config.mjs`; exit 0. |
| `pnpm format:check` | Pass | 4/4 workspace tasks + root config files (`package.json`, `turbo.json`, `tsconfig.base.json`, `opencode.json`, `.lintstagedrc.json`, `.prettierrc.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`); exit 0. |
| `pnpm type-check` | Pass | 5/5 tasks; exit 0. |
| `pnpm test` | Pass | 5/5 tasks; `shared-types` real test passes; others `--passWithNoTests`. |
| `pnpm build` | Pass | 4/4 tasks; the two `no output files` warnings for `@notted/api`/`@notted/web` are the known Part 2 scaffold `build` placeholders resolved in Parts 4/5. |
| **Verify gate (Part 3):** malformed `apps/api/src/sample-malformed.ts` | Pass (caught) | `pnpm --filter @notted/api lint` → exit 1 (3 errors: unused vars, explicit `any`); `format:check` → exit 1. File removed → both exit 0. |
| **Next.js verify gate:** temporary malformed TSX using `<img>` | Pass (caught) | `pnpm --filter @notted/web lint` failed on `@next/next/no-img-element` under `--max-warnings 0`; sample removed; filtered web lint passed. |
| **NestJS verify gate:** temporary duplicate `@Injectable()` decorators | Pass (caught) | Direct ESLint invocation failed on `@darraghor/nestjs-typed/no-duplicate-decorators`; sample removed; filtered API lint passed. |
| **Fail-on-warning proof** | Pass | `eslint _warn-demo.js --rule '{"no-console":"warn"}' --max-warnings 0` → exit 1, "ESLint found too many warnings (maximum: 0)"; with `--max-warnings 1` → exit 0. |
| **Pre-commit hook end-to-end** | Pass | Staged `export const hookTest=()=>"x";` → `sh .husky/_/pre-commit` ran lint-staged (`eslint --fix` + `prettier --write`), auto-formatted to `export const hookTest = () => "x";`, re-staged, exit 0. `HUSKY=0 sh .husky/_/pre-commit` → exit 0, no formatting (escape hatch confirmed). |
| **Root-config coverage (low-finding fix)** | Pass | Injecting bad formatting into `.lintstagedrc.json` → `pnpm format:check` exit 1; injecting an unused var into `eslint.config.mjs` → `pnpm lint` exit 1 (`no-unused-vars`). Both restored; gate green again. |
| Clean → full rebuild (`pnpm clean` then build/type-check/test/lint/format:check) | Pass | All exit 0 from a clean cache; reproducible. |
| Boundary/scope scan | Pass | Framework lint plugins are root dev-only tooling scoped to `apps/web` and `apps/api`; no Next.js or NestJS runtime/application scaffold was added. |
| Dependency review | Pass | Original nine toolchain packages plus four exact framework-lint packages/direct peers are dev-only; strict peer installation passes on Node 22. |
| `git diff --check` | Pass | No whitespace errors. |
| Independent `quality-reviewer` passes (`$notted-quality-operations`) | Pass | Original review resolved the root-config coverage finding. The 2026-07-23 correction review found no findings at any severity and independently reproduced strict dependency resolution, live app lint, framework-specific malformed probes, and the broad gate. |

The 2026-07-23 correction was additionally verified with an uncached root gate: `pnpm lint`
(4/4), `pnpm format:check` (4/4), `pnpm type-check` (5/5), `pnpm test` (5/5,
one real shared-types test and three no-test scaffolds), and `pnpm build` (4/4). The app
builds remain the intentional Part 4/5 placeholder echoes and therefore retain Turborepo's
known no-output warnings.

## Known Limitations and Follow-up Work

- **Framework scaffolds remain in Parts 4/5.** Part 4 may adopt `eslint-config-next` when Next.js itself is installed, but must preserve or equivalently cover the existing Core Web Vitals rules. Part 5 must reassess and enable `@darraghor/nestjs-typed/injectable-should-be-provided` after genuine Nest modules exist.
- **NestJS type-aware lint is comparatively slow** on this WSL `/mnt/d` filesystem (observed around 90–110 seconds for an uncached API lint). This is a known local performance cost, not a skipped rule set; Part 5 should measure it again with the real source tree.
- **`import/no-unresolved` not enabled** (no resolver installed). Enabling it later requires `eslint-import-resolver-typescript` and approving the `unrs-resolver` build script (`pnpm approve-builds`).
- **`pnpm test`/`pnpm lint` cold start** on this WSL `/mnt/d` (drvfs) filesystem can take ~1 min for the first typescript-eslint run per workspace; subsequent turbo runs are cached (~0.3s). Native Linux filesystems are unaffected.
- **Root-config Prettier list is explicit.** The root `format`/`format:check` scripts list root config files by name (because fast-glob excludes dotfiles). If new root config files are added, extend the list.

## Handoff Notes

- The shared ESLint flat config lives at the repo root; do not add per-workspace `.eslintrc`/`eslint.config.*` files — extend the root config with `files:`-scoped blocks instead. Workspace `lint` scripts rely on ESLint discovering the root config by walking up from the linted file.
- `pnpm lint` (and `format:check`) now cover root config files via chained commands; preserve the `turbo run <task> && <root check>` shape and remember `turbo run <task>` excludes the root package (no recursion).
- Pre-commit is optional and reproducible: `pnpm lint`/`pnpm format` run the same checks; `HUSKY=0` disables hooks; `--no-verify` skips a single commit.
- Treat the pinned ESLint toolchain as a constraint; record any version change with fresh strict-peer evidence (jsx-a11y currently caps ESLint at 9).
- When Parts 4/5 install the framework runtimes or change their lint integration, run `pnpm install --frozen-lockfile --strict-peer-dependencies`, preserve app-scoped framework rules, and run the full gate before accepting the combination.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-22 | `lead-part-engineer` | Initial record after full Verify gate and independent `quality-reviewer` pass (no critical/high/medium findings; low finding on root-config coverage resolved during this part). |
| 2026-07-23 | `lead-part-engineer` | Added and verified app-scoped Next.js Core Web Vitals and type-aware NestJS lint rules, correcting the earlier framework-lint deferral; independent final review found no issues at any severity. |
