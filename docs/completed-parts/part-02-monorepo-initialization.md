# Part 02 — Initialize the pnpm/Turborepo monorepo

## Status

- **State:** Complete
- **Completed on:** 2026-07-22
- **Implemented by:** `lead-part-engineer` (Part 2) with an independent `quality-reviewer` pass
- **Plan reference:** `Plan.md`, Part 2
- **Related records:** `part-01-architecture-decisions.md`; `docs/decisions/0001-monorepo-boundaries.md`; `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Stand up the pnpm + Turborepo monorepo foundation so every later part builds inside one reproducible workspace: root configuration, the four canonical roots from `Notted.md` (`apps/web`, `apps/api`, `packages/shared-types`, `packages/shared-validators`), root task scripts, and Turborepo task ordering/caching that builds packages before dependent applications. Part 2 establishes the harness only; framework adoption (Next.js, NestJS), lint/format enforcement, shared contracts, and Drizzle migrations belong to Parts 3–6 and 12.

## Implemented Work

- **Root workspace**: `package.json` (private root, `packageManager: pnpm@10.34.5`, `engines.node >=22.12.0 <23`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`, `.editorconfig`, `.dockerignore`, and an extended `.gitignore` that preserves the pre-existing `Agent-Prompt-Examples.md` line.
- **Root scripts** (Plan Part 2 required set): `dev`, `build`, `type-check`, `lint`, `format`, `test`, `db:migrate`, `db:generate`, `db:studio`, `db:seed`, `clean`, `clean:deps`. All operational scripts delegate to Turborepo; database scripts are explicit placeholders pointing to their owning parts; `clean`/`clean:deps` use root `rimraf`.
- **Turborepo pipeline**: `build` depends on `^build` with `outputs: ["dist/**"]` so packages build before dependent apps; `type-check` and `test` depend on `^build` so app type-checking/tests resolve built package declarations; `dev` is `persistent`/uncached; `globalDependencies` invalidate caches when the shared base config changes.
- **Shared TypeScript base** (`tsconfig.base.json`): strict mode with `noUncheckedIndexedAccess`, `isolatedModules`, `module: Preserve` / `moduleResolution: Bundler`, `noEmit` (type-check only); emitting workspaces use a separate `tsconfig.build.json`.
- **`packages/shared-types`**: `@notted/shared-types`, private, CommonJS, `exports`/`types` point to `dist`, builds with `tsc` (declaration emit, `*.test.ts` excluded). Barrel exposes `APP_NAME = "Notted"` (a legitimately shared domain constant) plus a Vitest test asserting it.
- **`packages/shared-validators`**: `@notted/shared-validators`, private, CommonJS, builds today; barrel is intentionally `export {}` because Zod and the schema set are introduced in Part 6 (per ADR 0008).
- **`apps/web` and `apps/api`**: private scaffold workspaces. `type-check` runs `tsc --noEmit`; `test` runs `vitest run --passWithNoTests`; `build` is a documented placeholder (Next.js build in Part 4, NestJS build in Part 5). Each app declares `@notted/shared-types: workspace:*` and re-exports `APP_NAME` to prove apps→packages resolution and the dependency direction from ADR 0001. `apps/api` adds `@types/node`; `apps/web` adds DOM lib + `jsx: preserve`.
- **Pinned versions** (exact): Node `22.23.1` (`.nvmrc`, matches the runtime), pnpm `10.34.5` (`packageManager`, corepack-activated), TypeScript `5.9.3` (ADR 0008). Resolved and pinned this part: `turbo 2.10.6`, `vitest 4.1.10`, `rimraf 6.1.3`, `@types/node 22.20.1`. `.npmrc` sets `save-exact=true`, `engine-strict=true`, `auto-install-peers=true`.

## Important Decisions

- **Harness only, no framework adoption.** ESLint/Prettier (Part 3), Next.js (Part 4), NestJS (Part 5), Zod/shared contracts (Part 6), and Drizzle (Part 12) are deliberately omitted. Their root scripts (`lint`, `format`, `db:*`) and per-app `build` scripts exist as clearly-labeled placeholders so the root script set and Verify gate run today without pre-empting later parts.
- **Placeholder lint/format scripts are explicit and documented**, not silent passes. Each workspace's `lint`/`format` echoes which part introduces real enforcement; the completion record states the same. This satisfies Part 2's "scripts run across workspaces" while Part 3 owns actual tooling.
- **CommonJS packages with separate type-check vs. build configs.** `tsconfig.base.json` is `noEmit` for type-checking; packages emit via `tsconfig.build.json` (`module: CommonJS`, `moduleResolution: Node10`, `declaration`). CommonJS is the safest shared-package format for the NestJS (CommonJS) runtime selected in ADR 0008; it is consumed correctly by both apps. Part 6 may revisit ESM if contracts require it.
- **One real test, plus `--passWithNoTests`.** `shared-types` has a genuine test proving the runner detects pass/fail; app and `shared-validators` workspaces use `vitest run --passWithNoTests` so empty scaffold workspaces pass honestly. No throwaway tests were invented for apps.
- **Apps import `@notted/shared-types` to prove wiring.** This demonstrates Turborepo `^build` ordering, pnpm workspace resolution, and the ADR 0001 dependency direction end-to-end (type-checking the apps requires the package to have built its `dist` declarations first).
- **Strict peer resolution proven for the Part 2 toolset** via `pnpm install --frozen-lockfile --strict-peer-dependencies` (exit 0). Per ADR 0008, `.npmrc` does not set global `strict-peer-dependencies` (to avoid spurious failures from unrelated transitive peers); strictness is proven as a verification step. The full ADR 0008 framework matrix is validated in its owning parts.
- **Single source of truth for the Node version is `.nvmrc`** (`22.23.1`); `engines.node` declares the supported range (`>=22.12.0 <23`) from ADR 0008.

## Files and Components

| Path | Purpose |
|---|---|
| `package.json` | Root workspace config, `packageManager` pin, engines, root task scripts, root devDeps (`turbo`, `rimraf`). |
| `pnpm-workspace.yaml` | Workspace globs `apps/*` and `packages/*`. |
| `turbo.json` | Task graph: `build` (`^build`, outputs `dist/**`), `type-check`/`test` (`^build`), `lint`/`format`, `dev` (persistent); `globalDependencies` and `globalEnv`. |
| `tsconfig.base.json` | Shared strict TypeScript base (type-check, `noEmit`). |
| `.npmrc` | `save-exact`, `engine-strict`, `auto-install-peers`. |
| `.nvmrc` | Node `22.23.1`. |
| `.editorconfig` | Editor formatting conventions. |
| `.dockerignore` | Excludes deps, build outputs, env/secrets, docs, and agent scaffolding from image context. |
| `.gitignore` | Node/TS monorepo ignores; preserves the existing `Agent-Prompt-Examples.md` entry. |
| `pnpm-lock.yaml` | Reproducible lockfile (`lockfileVersion: '9.0'`). |
| `packages/shared-types/{package.json,tsconfig.json,tsconfig.build.json,src/index.ts,src/index.test.ts}` | Shared domain contracts package (barrel + test); builds to `dist`. |
| `packages/shared-validators/{package.json,tsconfig.json,tsconfig.build.json,src/index.ts}` | Shared Zod schema package (empty barrel until Part 6); builds to `dist`. |
| `apps/web/{package.json,tsconfig.json,src/index.ts}` | Next.js scaffold (Part 4); consumes `@notted/shared-types`. |
| `apps/api/{package.json,tsconfig.json,src/index.ts}` | NestJS scaffold (Part 5); consumes `@notted/shared-types`; node types. |

## Database and Data Changes

None. Part 2 creates no schema, migration, or seed. The `db:migrate`/`db:generate`/`db:studio`/`db:seed` root scripts are documented placeholders that resolve to Drizzle tooling in Part 12 (migrations/studio) and Part 20 (seed).

## API, Configuration, and Operational Changes

- No runtime routes, ports, or deployable services. No application boot or environment variables are introduced.
- New operational scripts: `pnpm dev|build|type-check|lint|format|test`, `pnpm db:migrate|db:generate|db:studio|db:seed` (placeholders), `pnpm clean` (removes `dist`/`.turbo`/`coverage` repo-wide), `pnpm clean:deps` (removes `node_modules`). Defaults are safe for development; nothing runs automatically.
- Tooling versions are pinned exact and recorded above. Container and CI pins must use Node `22.23.1` and pnpm `10.34.5` unless a later part revalidates and records a newer patch (ADR 0008).

## Security and Tenant-Isolation Notes

No new security impact: Part 2 is repository scaffolding with no application code, transports, persistence, or auth. Hygiene verified: `.gitignore` keeps `.env*` out of git while allowing `.env.example`; `.dockerignore` excludes dependencies, build outputs, all environment files, logs, and secrets from image context. A scoped scan of all new source/config files found no secrets, tokens, credentials, or personal data (the only secret-looking strings in the repo are pre-existing examples in `Notted.md`). `clean` does not touch sources or `node_modules` by default; `clean:deps` is a separate, clearly named destructive operation.

## Verification Evidence

All commands run from the repository root with Node `v22.23.1` and pnpm `10.34.5` (corepack-activated). Results were independently reproduced by the `quality-reviewer` agent.

| Check | Result | Notes |
|---|---|---|
| `corepack prepare pnpm@10.34.5 --activate` then `pnpm --version` | Pass | Reports `10.34.5`, matching `packageManager` and ADR 0008. |
| `node --version` / `.nvmrc` | Pass | `v22.23.1`; engines `>=22.12.0 <23` satisfied. |
| `pnpm install` | Pass | Resolved 58 packages, no peer errors; root devDeps `turbo 2.10.6`, `rimraf 6.1.3`; workspace deps installed. |
| `pnpm install --frozen-lockfile` | Pass | Exit 0; lockfile reproducible (`lockfileVersion: '9.0'`). |
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Pass | Exit 0; strict peer resolution proven for the Part 2 toolset. |
| `pnpm build` | Pass | 4/4 tasks; `@notted/shared-types` and `@notted/shared-validators` emit `dist/index.js` + `dist/index.d.ts`; apps run documented placeholder echoes. Two benign turbo warnings note that scaffold apps declare no build outputs (Parts 4/5 add them). |
| `pnpm type-check` | Pass | 5/5 tasks; apps resolve and type-check against the rebuilt `@notted/shared-types` declarations via `^build` ordering. |
| `pnpm lint` | Pass | 4/4 workspaces; placeholder scripts (ESLint enforcement arrives in Part 3). |
| `pnpm format` | Pass | 4/4 workspaces; placeholder scripts (Prettier enforcement arrives in Part 3). |
| `pnpm test` | Pass | 5/5 tasks; `shared-types` real test passes (1/1); app and `shared-validators` workspaces pass with `--passWithNoTests`. |
| `pnpm dev` | Pass | Exit 0; "No tasks were executed" (no `dev` script until Parts 4/5); no hang. |
| `pnpm clean` | Pass | Removed `dist`/`.turbo`/`coverage` repo-wide; `node_modules` and sources untouched. |
| Rebuild after `clean`, then second `pnpm build` | Pass | First 4/4 (0 cached); second 4/4 (4 cached, `FULL TURBO`) — cache behavior and reproducibility confirmed. |
| `git diff --check` | Pass | No whitespace errors. |
| Scoped secret/placeholder scan of new files | Pass | No matches in Part 2 source; secret-like strings exist only in pre-existing `Notted.md` examples and Part 1 record. |
| Boundary/scope scan | Pass | No `apps/` imports inside `packages/`; no ESLint/Prettier/Next/Nest/Drizzle/Zod dependencies introduced (no over-reach into Parts 3/4/5/6/12). |
| Independent `quality-reviewer` pass (`$notted-quality-operations`) | Pass | No critical/high technical findings; implementation conforms to ADR 0001 and ADR 0008; gate reproduced end-to-end. |

## Known Limitations and Follow-up Work

- **Part 3** installs ESLint and Prettier and replaces the placeholder `lint`/`format` scripts with real enforcement (and CI-failing-on-warning). Until then `pnpm lint`/`pnpm format` are explicit no-op placeholders, not real checks.
- **Parts 4 and 5** replace `apps/web` and `apps/api` placeholder `build`/`src/index.ts` with the real Next.js App Router and NestJS module graph from `Notted.md`, and add real turbo build outputs (`.next/**` and `dist/**` respectively) to silence the two benign scaffold warnings.
- **Part 6** adds Zod to `packages/shared-validators` and the full shared contract set to `packages/shared-types`.
- **Part 12** wires `db:migrate`/`db:generate`/`db:studio` to Drizzle; **Part 20** wires `db:seed`.
- **Non-blocking turbo nits (from review)**: (a) the `build` task hashes `*.test.ts` files even though they are excluded from compilation (minor cache efficiency only); (b) the `test` task lists a forward-looking `vitest.config.ts` input that does not exist yet (turbo is lenient). Both are acceptable at scaffold stage and can be refined when Part 3+ restructures turbo inputs.
- **Environment-specific note**: on this WSL `/mnt/d` (drvfs) filesystem, re-runs of `pnpm install` can emit transient `WARN Failed to create bin ... ENOENT chmod` messages; the binaries are nonetheless created and functional (`tsc 5.9.3`, `vitest 4.1.10` resolve from each workspace). Native Linux CI (Part 7) is unaffected.

## Handoff Notes

- Treat the pinned versions (Node `22.23.1`, pnpm `10.34.5`, TypeScript `5.9.3`, and the Part 2 toolset above) as constraints; record any patch change with fresh engine/peer evidence per ADR 0008.
- Package builds emit CommonJS + declarations to `dist`. Any package that later needs ESM must add a separate build target and verify both apps still resolve it.
- `type-check` and `test` already depend on `^build`; any new package consumed by an app will be type-checked/tested against its built declarations automatically as long as it exposes `exports`/`types` to `dist`.
- The placeholder `lint`/`format`/`db:*`/app `build` scripts are intentional scaffolding — Part 3/4/5/6/12/20 own their replacements. Do not interpret a green `pnpm lint`/`pnpm format` today as real enforcement.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-22 | `lead-part-engineer` | Initial record after full Verify gate and independent `quality-reviewer` pass returned no critical/high technical findings. |
