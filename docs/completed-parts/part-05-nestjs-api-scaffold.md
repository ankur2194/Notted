# Part 05 — Scaffold the NestJS API Application

## Status

- **State:** Complete
- **Completed on:** 2026-07-27
- **Implemented by:** `lead_part_engineer_part5` acting as the backend specialist
- **Plan reference:** `Plan.md`, Part 5
- **Related records:** `part-01-architecture-decisions.md`; `part-02-monorepo-initialization.md`; `part-03-formatting-linting-commit-gates.md`; `docs/decisions/0001-monorepo-boundaries.md`; `docs/decisions/0002-api-boundary.md`; `docs/decisions/0003-authentication-ownership.md`; `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Replace the API placeholder with the strict NestJS 10 foundation required by later backend parts: validated configuration, secure HTTP defaults, versioned routing, stable errors, health probes, request correlation and structured logs, graceful shutdown, and abuse-resistant rate limiting. Database, authentication-provider, transport, tenant-resource, queue, storage, and other provider integrations remain assigned to later parts.

## Implemented Work

- Added the NestJS entry point, root/config/common/health modules, production build configuration, and development/start scripts.
- Added typed startup validation for `NODE_ENV`, `API_HOST`, `API_PORT`, `APP_URL`, `LOG_LEVEL`, `TRUST_PROXY_HOPS`, `REQUEST_BODY_LIMIT_BYTES`, `RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE`, and `RATE_LIMIT_AUTHENTICATED_PER_MINUTE`. Development defaults are loopback port 3001, browser origin `http://localhost:3000`, a 1 MiB body limit, and rate tiers of 60/1000 per minute; production requires `APP_URL`.
- Configured explicit trusted-proxy hops, strict single-origin credentialed CORS, Helmet, compression, bounded JSON/form parsing, global strict validation, UUID request IDs, safe error envelopes, and graceful shutdown hooks.
- Added Pino JSON logging with fixed service/environment fields, aggressive credential/content redaction, request IDs, safe paths without query strings, status, duration, and outcome. Unexpected errors log only safe metadata.
- Exposed `GET /health/live` and `GET /health/ready` outside the version prefix. Liveness has no dependencies; readiness initially reports the API process through a replaceable indicator contract for Part 11.
- Exposed a minimal `GET /api/v1` service probe to establish versioned routing.
- Added a global token-bucket guard with separate configuration-backed tiers, standard rate headers, bounded cardinality, periodic stale-entry pruning, and an injectable `RateLimitStore` abstraction. Only a server-set symbol-backed `TrustedPrincipal` selects the authenticated tier; authorization, cookie, and forwarding headers never do.
- Added unit and HTTP integration tests for configuration boundaries, token refill/denial/pruning/cardinality, trusted-principal selection and spoof resistance, health behavior, version routing, request IDs, CORS, security/rate headers, malformed JSON, payload bounds, and safe error bodies. Tests were written but deliberately not run during parallel initial implementation.

## Important Decisions

- NestJS core/common/platform versions remain on ADR 0008's `10.4.22` line; every direct dependency is exact-pinned. The lockfile is intentionally not changed in this parallel workstream and must be resolved and strict-peer-checked centrally.
- The Phase 1 rate-limit store is intentionally in-process and bounded. Its interface allows a later Redis-backed implementation without changing the guard; multi-instance shared enforcement belongs with dependency clients or public API rate-limit work.
- Health probes are exempt from abuse throttling so orchestrator checks cannot consume application traffic capacity. Readiness is dependency-extensible while initially proving only that the API process can serve.
- Incoming request IDs are reflected only when they are syntactically valid UUIDv4 values; otherwise the server creates a UUID. The authenticated rate tier likewise requires an internal principal installed after real credential validation in Part 21.
- The API consumes `APP_NAME` through the `@notted/shared-types` root barrel, preserving the workspace dependency direction while Part 6 expands that package.
- No material deviation from `Notted.md` or an accepted ADR was introduced.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/main.ts`, `app.module.ts`, `api.controller.ts` | Bootstrap, secure global HTTP configuration, module graph, and `/api/v1` root. |
| `apps/api/src/config/` | Typed environment parsing, helpful startup failures, and injected immutable configuration. |
| `apps/api/src/common/` | Safe errors, structured/redacted logging, request IDs, trusted principals, and bounded rate limiting. |
| `apps/api/src/health/` | Dependency-free liveness and indicator-based readiness. |
| `apps/api/src/**/*.test.ts`, `apps/api/test/app.e2e.test.ts` | Configuration, store/guard, security, health, and HTTP behavior coverage. |
| `apps/api/package.json`, `nest-cli.json`, `tsconfig*.json` | Exact runtime/test dependencies and strict NestJS build/type-check configuration. |

## Database and Data Changes

None. No database module, schema, migration, seed, transaction, or tenant-owned data is introduced in Part 5.

## API, Configuration, and Operational Changes

- Routes: `GET /health/live`, `GET /health/ready`, and `GET /api/v1`.
- Failure responses use `{ success: false, error: { code, message, details? }, requestId }`. Validation details contain paths, constraint codes, and safe messages without rejected values.
- The process listens on `API_HOST`/`API_PORT` (development defaults `127.0.0.1:3001`) and accepts browser CORS requests only from the `APP_URL` origin.
- `REQUEST_BODY_LIMIT_BYTES` is bounded from 1 KiB through 10 MiB. Proxy trust is explicit from zero through 16 hops. Rate values must be positive bounded integers.
- SIGTERM/SIGINT shutdown hooks are enabled. No dependency clients or service containers are required.

## Security and Tenant-Isolation Notes

- No tenant resources exist yet. This part adds no authorization claim; a credential-like header cannot obtain the authenticated rate tier.
- The internal principal contains only actor ID and credential kind. Part 21 must set it only after Better Auth or API-key validation and must order that validation before rate-limit evaluation.
- Logs omit headers, bodies, query strings, cookies, credentials, personal content, and error details. Error responses do not echo parser input, stack traces, or internal exception messages.
- The in-memory store is protected from unbounded key growth by a 50,000-entry maximum, least-recent eviction, and ten-minute inactivity pruning.

## Verification Evidence

The coordinating parent reconciled the parallel implementation and ran the integrated checks on 2026-07-24.

| Check | Result | Notes |
|---|---|---|
| Dependency install / frozen strict peer resolution | Pass | `pnpm install --frozen-lockfile --strict-peer-dependencies` completed with the exact lockfile. |
| API unit/integration tests | Pass | `pnpm --filter @notted/api test`: 6 files and 26 tests passed, including Nest bootstrap and HTTP E2E behavior. |
| Formatting | Pass | `pnpm format:check` passed all workspaces and the repository root. |
| Lint | Pass with split evidence | A current `pnpm lint` run passed all four workspace tasks; it was stopped when the unchanged root-config self-check stalled. The same root self-check passed earlier at the current ESLint configuration revision. |
| Strict type-check | Pass | `pnpm type-check`: 6 tasks passed. |
| Production build | Pass | `pnpm build`: all 4 workspace builds passed. |
| API start and HTTP behavior | Pass through E2E | The E2E suite creates the real Nest application, initializes its HTTP adapter, exercises all three routes and failure/security behavior, and closes it cleanly. A separate built-process/curl smoke was not run. |
| CI coverage command | Partial / environment-limited | API coverage passed 26/26 tests and every configured 70% threshold. The root run failed only when web jsdom workers timed out starting from the mounted Windows filesystem. |
| Dependency audit | Historical fail; production issue remediated later | This 2026-07-24 run included Nest CLI/tooling findings and Multer `2.0.2`. Phase 2 later applied the reviewed `multer@2.2.0` override; the 2026-07-27 production audit has no high finding, while the full development audit still reports six high tooling advisories. |
| Migration sentinel | Pass | `pnpm db:check` confirmed no premature Drizzle surface. |
| Diff integrity | Pass | `git diff --check` passed before the completion-record update and is rerun at handoff. |
| Quality review | Pass with blockers retained | The parent reviewed security boundaries, DI/module ownership, request/error/log safety, scope, and dependency risk; the user asked to skip a duplicative independent-agent review. |

## Known Limitations and Follow-up Work

- The Multer production advisory is resolved by the reviewed `multer@2.2.0` override in ADR 0008 without changing the NestJS major.
- Final verification on 2026-07-27 passed the API unit/E2E suite, configured coverage,
  formatting, lint, type-check, production build, and a built-process runtime smoke.
  Liveness remained dependency-free, readiness exercised live dependencies, malformed
  requests retained safe envelopes, and SIGINT shutdown returned immediately.
- The registry still classifies transitive development-only glob tooling as high. The
  reviewed paths are confined to Nest/ESLint developer CLIs with repository-controlled
  patterns; production audit has no high finding, and no incompatible framework/tooling
  major or unsafe transitive-major override was introduced to silence the report.
- `@darraghor/nestjs-typed/injectable-should-be-provided` is enabled against the real module graph. OpenAPI-response lint rules remain scoped off until Part 65 introduces the public API specification.
- Part 8 expands the complete environment contract. Part 11 adds dependency clients and real readiness indicators. Part 21 establishes authenticated principals. Part 65 may replace the local store with shared Redis enforcement and endpoint/API-key tiers.

## Handoff Notes

- Preserve the reviewed Multer override and reassess remaining Nest CLI/tooling advisories without changing the framework major unless ADR 0008 is updated.
- Preserve the E2E coverage for all three routes, malformed JSON, body limits, CORS, security headers, request IDs, shutdown, rate denial/refill, and spoof resistance.
- Preserve the symbol-backed principal trust boundary. Real authentication must install it from validated server state, never from raw request headers.
- Keep health endpoints outside `/api/v1`; future dependency checks extend readiness rather than liveness.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-24 | `lead_part_engineer_part5` | Added the initial Part 5 implementation and tests; left all verification pending for the coordinated Phase 1 integration pass. |
| 2026-07-24 | `/root` | Reconciled dependencies and contracts, fixed runtime bootstrap/DI issues, ran integrated verification, and retained `In progress` for unresolved high-severity Nest transitives. |
| 2026-07-27 | `/root` | Corrected the obsolete Multer advisory note after the reviewed Phase 2 override; retained development-tooling audit findings and current integration verification blockers. |
| 2026-07-27 | `/root` | Passed current tests/coverage, lint, type-check, build, built-process HTTP behavior, live readiness, and graceful shutdown; marked Part 5 complete. |
