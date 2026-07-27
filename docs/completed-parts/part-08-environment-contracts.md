# Part 08 — Define Environment Contracts

## Status

- **State:** Complete
- **Completed on:** 2026-07-27
- **Implemented by:** Phase 2 work-in-progress checkpoint
- **Plan reference:** `Plan.md`, Part 8
- **Related records:** `part-05-nestjs-api-scaffold.md`; `part-09-development-compose-stack.md`; `part-10-developer-commands-onboarding.md`; `part-11-configuration-dependency-clients.md`

## Objective

Define typed, documented environment contracts for the API, web application, and local
infrastructure while keeping browser-visible values separate from server secrets and
rejecting unsafe production configuration.

## Implemented Work

- Added API configuration factories for application URLs and process settings, PostgreSQL,
  Redis, MinIO, Meilisearch, SMTP, Better Auth, encryption and storage limits, rate limits,
  feature flags, and optional OpenAI and Anthropic providers.
- Added a web contract that exposes only `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, and
  `NEXT_PUBLIC_WS_URL`.
- Added safe development examples at `docker/.env.example`, `apps/api/.env.example`, and
  `apps/web/.env.example`; ignored local environment files remain untracked.
- Added `pnpm env:init` to copy only missing local files and `pnpm env:check` to validate
  typed contracts plus selected cross-file port, name, and credential relationships.
- Added environment-contract tests for development/production acceptance, invalid input,
  secret-safe errors, and public-variable isolation.

## Important Decisions

- Configuration is parsed once into typed, frozen objects and injected through NestJS
  configuration tokens; rejected values are not included in validation errors.
- Production contracts require secure credential-free origins, strong database/auth/provider
  credentials, a versioned 32-byte encryption keyring, paired SMTP credentials, TLS where
  required, and explicit feature-provider relationships.
- Optional providers are disabled by absence rather than populated with placeholder secrets.
- Browser configuration is independently validated and cannot import server-only variables.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/.env.example` | Documented API development contract without real credentials. |
| `apps/api/scripts/validate-env.ts` | API environment preflight entry point. |
| `apps/api/src/config/*.config.ts` | Typed application and dependency configuration factories. |
| `apps/api/src/config/environment-readers.ts` | Shared safe parsing helpers. |
| `apps/api/src/config/environment-contract.test.ts` | Contract, production, and redaction tests. |
| `apps/web/.env.example` | Public web development contract. |
| `apps/web/scripts/validate-env.ts` | Web environment preflight entry point. |
| `apps/web/src/config/public-environment.ts` | Browser-visible environment parser. |
| `docs/environment.md` | Environment ownership, generation, validation, and rotation guidance. |
| `scripts/dev-tooling.mjs` | Cross-file initialization and validation orchestration. |

## Database and Data Changes

None. Part 8 changes configuration contracts only. The committed Part 12 Drizzle
configuration, schema export, migration test, and migration files are intentionally
unchanged by this checkpoint.

## API, Configuration, and Operational Changes

- Root commands now include `env:init` and `env:check`.
- API validation covers service endpoints, connection and probe timeouts, storage limits,
  signed-URL lifetime, encryption keys, authentication, SMTP, AI, and feature flags.
- Web production validation requires HTTPS/WSS public URLs.
- Development defaults are present in example files; production secrets have no committed
  default.

## Security and Tenant-Isolation Notes

- No local `.env` values are recorded here or staged.
- Validation errors identify the variable and rule without echoing a rejected credential.
- Production URLs reject embedded credentials and insecure schemes.
- This part adds no tenant-owned data or authorization surface.
- Development examples intentionally reuse local-only MinIO/Meilisearch administrative
  credentials to keep Part 9 onboarding deterministic. Production contracts require
  explicit application credentials; scoped identities are introduced with the owning
  storage/search features and production hardening rather than implied by examples.

## Verification Evidence

Evidence below applies to the current Phase 2 worktree audited on 2026-07-27.

| Check | Result | Notes |
|---|---|---|
| `pnpm type-check` | Pass | Root type-check passed; uncached API and web package type-checks also passed. |
| Focused API/web environment tests | Stalled / interrupted | Test workers repeatedly stalled on the mounted filesystem; no pass is claimed. |
| API validator execution through `tsx` | Unavailable | The read-only audit sandbox could not create the required IPC socket (`EPERM`). |
| `pnpm build` | Fail / local configuration | An ignored local web environment selected insecure URLs under production validation; API build was then cancelled. No local value was inspected or recorded. |
| `pnpm format:check` | Fail | Phase 2 formatting failures exist in five files, listed in the Part 11 record. |
| Invalid production URL, port, key length, and missing-secret CLI cases | Not run | Source tests exist, but the required executable preflight proof remains. |

### 2026-07-27 final completion verification

| Check | Result | Notes |
|---|---|---|
| Focused API/web contract tests | Pass | Development defaults, complete production contracts, invalid URL/port/key/secret cases, display-name email, 50 MiB limit, redaction, and public allow-list passed. |
| `pnpm env:check` | Pass | Example-derived local files were typed and mutually consistent. |
| API `--production` with missing configuration | Pass (rejected) | Exited non-zero at `API_HOST is required`, proving forced production semantics without reading ignored local values. |
| Production build | Pass | API and web contracts accepted explicit secure CI configuration. |
| Broad repository gates | Pass | Frozen install, formatting, lint, type-check, tests/coverage, build, and production audit passed. |

## Known Limitations and Follow-up Work

- Production preflight now validates an immutable `NODE_ENV=production` snapshot and
  demonstrably rejects missing production configuration.
- Cross-file parsing uses Node's dotenv parser, supports quoting/comments, decodes URL
  credentials for safe comparison, and reports only variable names/categories.
- The canonical upload default is 50 MiB, and `EMAIL_FROM` accepts both a bare mailbox and
  the specified display-name form while rejecting CR/LF injection.
- Focused API/web contract tests, `env:init`, `env:check`, invalid URL/port/key/missing-secret
  cases, production builds, formatting, lint, and type-check all pass.
- Provider-specific production credential provisioning remains deployment/feature work;
  Part 8 owns validation and documentation, not account creation.

## Handoff Notes

- Never copy ignored local environment values into this record, logs, fixtures, or commits.
- Preserve the separation between server secrets and the three public web variables.
- Part 12 is a completed prerequisite and is frozen during Phase 2 remediation. Its exact
  immutable-file hashes are recorded in the Part 11 handoff.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-27 | `/root` | Created an honest Phase 2 work-in-progress checkpoint; implementation and required verification remain incomplete. |
| 2026-07-27 | `/root` | Fixed production semantics, dotenv parsing, canonical upload/email contracts, completed executable validation/build gates, and marked Part 8 complete. |
