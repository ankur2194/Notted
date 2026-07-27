# Part 10 — Add Developer Commands and Onboarding Documentation

## Status

- **State:** Complete
- **Completed on:** 2026-07-27
- **Implemented by:** Phase 2 work-in-progress checkpoint
- **Plan reference:** `Plan.md`, Part 10
- **Related records:** `part-08-environment-contracts.md`; `part-09-development-compose-stack.md`; `part-11-configuration-dependency-clients.md`

## Objective

Provide safe, reproducible developer commands and enough onboarding documentation for a
new contributor to move from a clone to running infrastructure and host-based applications.

## Implemented Work

- Added root commands for environment initialization/validation, infrastructure
  start/stop/status/logs/reset, host application development, builds, checks, tests, and
  Drizzle check/generate/migrate/studio workflows.
- Added a thin `Makefile` alias layer over the canonical pnpm commands.
- Added a Node-based developer wrapper that derives a checkout-specific Compose project
  name, waits up to 180 seconds for the five persistent services plus `minio-init`, and
  preserves volumes during normal shutdown.
- Added an explicitly destructive `infra:reset:dev` flow with production/Compose override
  guards and an exact interactive confirmation phrase.
- Added root and developer documentation for prerequisites, startup order, ports,
  environment ownership, WSL/Docker troubleshooting, migrations, reset safety, and the
  current absence of seed/first-login credentials.
- `db:seed` deliberately fails with guidance because Part 20 has not implemented a seed.

## Important Decisions

- Root pnpm scripts are canonical; Make targets remain convenience aliases.
- Infrastructure runs in Compose while API and web processes run on the host.
- Normal `infra:down` never deletes volumes. Destructive deletion has a separately named,
  interactive command.
- Compose project identity is derived from the canonical checkout path to isolate concurrent
  worktrees.
- Migration generation, application, and studio commands are exposed, but deployed
  migration files remain immutable.

## Files and Components

| Path | Purpose |
|---|---|
| `Makefile` | Thin aliases for environment, infrastructure, app, test, and database commands. |
| `package.json` | Canonical developer command surface. |
| `scripts/dev-tooling.mjs` | Environment orchestration, project/legacy-volume discovery, Compose identity/waiting, reset guards, and seed placeholder. |
| `scripts/dev-tooling.test.mjs` | Dotenv, legacy-volume, local-daemon, and destructive-boundary regression tests. |
| `README.md` | Short repository entry point and startup sequence. |
| `docs/README.md` | Detailed local onboarding and troubleshooting guide. |
| `docs/environment.md` | Environment-file ownership and validation guide. |
| `turbo.json` | Updated environment/task inputs for reproducible commands. |

## Database and Data Changes

No schema or seed data is added. `db:seed` remains an intentional non-zero placeholder until
Part 20. The reset command can delete only the selected development Compose project's named
volumes after confirmation. It rejects ambient Docker/Compose target overrides, resolves
the active context, permits only local Unix/npipe endpoints, and invokes deletion through
that verified context.

## API, Configuration, and Operational Changes

- Added `env:init`, `env:check`, `infra:up`, `infra:down`, `infra:status`, `infra:logs`,
  `infra:project`, `infra:reset:dev`, `dev`, `dev:api`, `dev:web`, and database workflow
  commands.
- `infra:up` leaves a failed partial stack in place for diagnosis instead of silently
  deleting state.
- Documentation explicitly says seed and first-login credentials do not yet exist.

## Security and Tenant-Isolation Notes

- Destructive reset rejects production mode, ambient Compose file/project overrides, an
  unexpected Compose filename, and a non-Notted project name, and requires an exact phrase.
- Reset rejects ambient `DOCKER_HOST`/`DOCKER_CONTEXT`, positively inspects the active
  Docker context endpoint, and refuses non-local protocols before prompting.
- Documentation contains names/placeholders only; ignored local credentials are excluded.
- This part introduces no tenant resource or authorization behavior.

## Verification Evidence

Evidence below applies to the current Phase 2 worktree audited on 2026-07-27.

| Check | Result | Notes |
|---|---|---|
| Static command and documentation review | Pass with findings | Command wiring, startup order, migration guidance, and reset checks were inspected. |
| `docker compose ... config` through the canonical development file | Pass | Compose rendered successfully with the example environment. |
| `pnpm type-check` | Pass | Root type-check passed. |
| Developer-tooling/reset automated tests | Not implemented | No direct regression suite currently covers project naming, environment parsing, waits, or destructive boundaries. |
| Guarded reset rehearsal | Not run | Docker daemon access was unavailable; no deletion was attempted. |
| Clone-to-running onboarding rehearsal | Not run | Docker startup and host runtime verification remain unavailable. |
| `pnpm format:check` | Fail | `scripts/dev-tooling.mjs` and other Phase 2 files are not currently formatted. |

### 2026-07-27 final completion verification

| Check | Result | Notes |
|---|---|---|
| `node --test scripts/dev-tooling.test.mjs` | Pass | Dotenv parsing, override refusal, local endpoint allow-list, remote endpoint refusal, and exact legacy matching passed. |
| `env:init` / `env:check` | Pass with split evidence | The copy-only initialization implementation was reviewed, and the typed/cross-file contract passed against initialized local files. |
| Compose lifecycle | Pass | Start, project/status, health wait, normal down, restart persistence, and logs were exercised on a disposable project. |
| Guarded reset boundaries | Pass | Automated tests proved confirmation, environment, override, Docker-context, endpoint, and exact legacy-name refusal boundaries. No volume deletion was needed for this verification. |
| Documented onboarding sequence | Pass with stepwise evidence | Frozen installation, environment validation, Compose startup, migration, and running API/web HTTP checks were exercised during the completion audit. |
| Quality commands | Pass | Formatting, lint, type-check, tests/coverage, and production build passed. |

## Known Limitations and Follow-up Work

- Node's dotenv parser replaces the custom parser; tests cover quotes, comments, target
  overrides, local/remote endpoints, and exact legacy-volume matching.
- Startup warns without mutating legacy data and links the full recovery runbook. Partial
  startup remains available for `infra:status`/`infra:logs` diagnosis.
- The documented clone-to-running order was verified step by step: frozen install,
  environment contract checks, alternate-port Compose startup, migration, API/web startup
  and HTTP checks, and normal down/restart persistence. The destructive reset path was
  verified through its pure guard tests rather than deleting a volume.
- Seed and first-login credentials intentionally remain absent until Part 20; the documented
  non-zero placeholder prevents a false onboarding claim.

## Handoff Notes

- Use `pnpm infra:down` for normal shutdown; never substitute the reset command.
- Do not invent seed or first-login credentials before Part 20 supplies them.
- Do not edit Part 12 migrations while fixing Phase 2 tooling. Exact protected hashes are
  recorded in the Part 11 handoff.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-27 | `/root` | Created an honest Phase 2 work-in-progress checkpoint with reset, recovery, onboarding, and verification blockers. |
| 2026-07-27 | `/root` | Hardened Docker targeting, added tooling tests/project and legacy discovery, completed recovery/onboarding documentation and stepwise verification, and marked Part 10 complete. |
