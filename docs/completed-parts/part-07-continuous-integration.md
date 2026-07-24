# Part 07 — Add continuous integration

## Status

- **State:** In progress
- **Completed on:** Not completed
- **Implemented by:** `lead-part-engineer` (initial implementation; central verification pending)
- **Plan reference:** `Plan.md`, Part 7
- **Related records:** `part-01-architecture-decisions.md`; `part-02-monorepo-initialization.md`; `part-03-formatting-linting-commit-gates.md`; `part-04-nextjs-web-scaffold.md`; Parts 5 and 6 are parallel prerequisites pending reconciliation

## Objective

Add a reproducible, least-privilege GitHub Actions gate for pull requests and pushes to
`main`. The gate must install the pinned toolchain from the frozen lockfile, run every
repository quality check, publish safe test evidence, and reject migration surfaces until
Part 12 supplies real Drizzle consistency validation.

## Implemented Work

- Added one bounded Ubuntu CI job for formatting, linting, type-checking, coverage-enabled
  unit tests, production builds, and migration consistency checks.
- Pinned every official GitHub action to an immutable commit SHA with its release version
  documented inline.
- Activated the repository's exact Node.js `22.23.1` and pnpm `10.34.5` baseline through
  Corepack and installed with a frozen lockfile and strict peer-dependency enforcement.
- Added concurrency cancellation and a 30-minute job timeout so superseded runs do not
  consume unbounded capacity.
- Cached only pnpm's content-addressed package store, keyed by OS, toolchain versions, and
  the lockfile hash. `node_modules`, Turborepo outputs, build outputs, and test outputs are
  not cached.
- Added always-running uploads for JUnit XML and V8 coverage outputs with seven-day
  retention. Missing evidence warns rather than masking the originating test/install
  failure.
- Added a read-only migration sentinel. Before Part 12, it succeeds only while no Drizzle
  dependencies, Drizzle config, or migration directories exist; once those surfaces
  appear, it fails with an explicit instruction to replace the sentinel with real
  migration consistency validation.

## Important Decisions

- **No service containers:** no Phase 1 gate requires PostgreSQL, Redis, Meilisearch, or
  MinIO. Later jobs should add a service only when their integration tests use it.
- **One quality job:** the current repository is small, and one install followed by ordered
  gates avoids duplicated dependency/network work. A failed gate stops later command
  gates while artifact publication still runs.
- **Official actions only:** `actions/checkout@v6.0.2`,
  `actions/setup-node@v7.0.0`, `actions/cache@v6.1.0`, and
  `actions/upload-artifact@v7.0.1` are full-SHA pinned. No third-party setup action is
  needed because pnpm is activated with Corepack.
- **Package-store-only cache:** dependency files and executable build outputs are never
  restored directly from cache. Installation still validates the frozen lockfile.
- **Sentinel instead of a false-positive migration pass:** Part 7 cannot validate Drizzle
  migrations that do not exist. The temporary check makes the absence explicit and is
  designed to fail when Part 12 starts, forcing that part to introduce the real gate.

## Files and Components

| Path | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Least-privilege pull-request and `main` push quality workflow. |
| `scripts/check-migrations.mjs` | Temporary read-only guard that rejects premature migration surfaces. |
| `docs/completed-parts/part-07-continuous-integration.md` | Part 7 implementation and verification handoff. |

## Database and Data Changes

None. No schema, migrations, database dependencies, or data services are introduced.
Part 12 must replace the absence sentinel when it adds Drizzle.

## API, Configuration, and Operational Changes

- GitHub Actions now targets `pull_request` events and pushes to `main`.
- Workflow token permissions are limited to `contents: read`; checkout credentials are not
  persisted.
- Workflow-wide `CI=true` and `HUSKY=0` make command behavior explicit and prevent
  development Git hooks from running during installation.
- The workflow invokes root `test:ci` and `db:check` scripts. Their root-script wiring and
  package-level coverage reporters are reconciled by the coordinating parent because those
  files are shared with the parallel Parts 5 and 6 implementations.
- No secrets, credentials, environment dumps, public endpoints, ports, or service
  containers are added.

## Security and Tenant-Isolation Notes

The workflow has read-only repository permission, persists no checkout credential, pins
all external action code immutably, and caches only pnpm's content-addressed package store
under an exact lockfile key. Uploaded artifacts are limited to dedicated JUnit and coverage
paths with short retention; logs do not print environment variables or secrets. This part
does not introduce runtime authorization or tenant-owned data.

## Verification Evidence

The coordinating parent reconciled the parallel package changes and ran the local command
sequence on 2026-07-24. Hosted positive and negative workflow proof remains unavailable
because the repository has no configured remote.

| Check | Result | Notes |
|---|---|---|
| Read `AGENTS.md`, Part 7, applicable `Notted.md` sections, ADRs, standards, prerequisite records, and completion checklist | Pass | Read-only context inspection completed before implementation. |
| Inspect current scripts, workspace packages, test configuration, migration surfaces, Git status, and Git remotes | Pass | No existing CI workflow, migration surface, or configured Git remote was present at inspection time. Unrelated Part 4 changes were preserved. |
| Verify official action release identities and full immutable SHAs | Pass | Read-only inspection of the official GitHub action repositories/releases completed on 2026-07-24. |
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Pass | Exact lockfile and strict peers verified. |
| `pnpm format:check` | Pass | All workspaces and repository-root files passed. |
| `pnpm lint` | Pass with split evidence | Current workspace lint tasks passed; the unchanged root-config self-check passed earlier at this configuration revision and stalled on the final duplicate invocation. |
| `pnpm type-check` | Pass | 6 tasks passed. |
| `pnpm test:ci` | Partial / local environment limitation | Shared types (3), validators (28), and API (26) passed with coverage artifacts and thresholds. Web assertions passed in ordinary mode (50/50), but coverage-mode jsdom workers intermittently timed out starting from the Windows-mounted path; attempted serialization was reverted after it also stalled. |
| `pnpm build` | Pass | All 4 workspace production builds passed; web statically generated `/`, `/_not-found`, and `/login`. |
| `pnpm db:check` | Pass | The sentinel confirmed there is no Drizzle dependency, config, or migration directory. |
| Dependency audit | Fail | The audit reports high transitive advisories under the pinned Nest 10 and Next 16 framework lines; no blind override was introduced. |
| Hosted GitHub Actions success | Skipped | No Git remote is configured; a local run cannot substitute for hosted evidence. |
| Hosted deliberate type/test failure, followed by revert and green run | Skipped | Requires a real GitHub branch/workflow run and remains a completion blocker. |

## Known Limitations and Follow-up Work

- The root `test:ci` and `db:check` scripts, package-level JUnit/V8 reporters, coverage
  thresholds, artifact outputs, and generalized root formatting coverage are integrated.
- The migration sentinel executed successfully. The workflow received static review, while
  its exact coverage command remains to be proven on GitHub's native Linux filesystem.
- Part 7 remains `In progress` until GitHub Actions records both a successful initial run
  and a deliberate broken type or test failure, followed by a reverted green run.
- Part 12 must replace `scripts/check-migrations.mjs`; retaining the sentinel after Drizzle
  appears intentionally fails CI.
- GitHub-hosted runners satisfy the Node 24 action runtime requirements. Any future
  self-hosted runner must meet the minimum runner versions documented by the pinned
  official actions before adoption.

## Handoff Notes

- Preserve the exact Node/pnpm pins from ADR 0008 unless a later part revalidates and
  records an update.
- Keep artifacts restricted to generated test evidence. Do not upload the workspace,
  logs, environment files, application content, or secrets.
- Add infrastructure services only to the specific job that consumes them; do not make
  PostgreSQL, Redis, Meilisearch, or MinIO unconditional CI dependencies.
- When Part 12 lands, replace—not relax—the sentinel with checks that generate/inspect
  migrations and prove the committed migration state is consistent.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-24 | `lead-part-engineer` | Added the initial CI workflow, migration sentinel, and an honest in-progress handoff record; central and hosted verification remain pending. |
| 2026-07-24 | `/root` | Integrated package CI scripts and artifacts, ran local gates, documented the mounted-filesystem coverage limitation, and retained hosted positive/negative proof as the completion blocker. |
