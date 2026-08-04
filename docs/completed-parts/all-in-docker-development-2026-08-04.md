# All-in-Docker development stack

## Status

- **State:** Complete
- **Completed on:** 2026-08-04
- **Implemented by:** Claude Code session, 2026-08-04
- **Plan reference:** Not a numbered `Plan.md` part. Supersedes the host-run application model established by Part 09 and Part 10, and is a prerequisite input to Phase 15 Parts 79–80.
- **Related records:** [part-08-environment-contracts.md](part-08-environment-contracts.md), [part-09-development-compose-stack.md](part-09-development-compose-stack.md), [part-10-developer-commands-onboarding.md](part-10-developer-commands-onboarding.md)

## Objective

Make `docker compose up` the only command required to run Notted in development, and cut
the published port surface down to what a developer's browser actually needs.

Before this change the development experience needed a matching host toolchain (Node
22.23.1, corepack, pnpm 10.34.5) and seven commands (`pnpm install`, `env:init`,
`env:check`, `infra:up`, `db:migrate`, `db:seed`, `dev`), and `docker/docker-compose.dev.yml`
published all nine infrastructure ports on `127.0.0.1` while both applications ran on the
host.

## Implemented Work

- Root [`compose.yaml`](../../compose.yaml) is a self-contained development stack:
  PostgreSQL, Redis, Meilisearch, MinIO (plus its `minio-init` bucket one-shot), Mailpit,
  a `deps` one-shot, a persistent `contracts` compiler, a `db-init` one-shot, and the
  `api` and `web` applications — eleven services, none of them privileged. It declares `name: notted-dev`
  so the bare CLI and the
  `pnpm infra:*` wrappers address one project, one set of containers, and one set of
  volumes.
- Every value uses `${VAR:-default}` interpolation, so no environment file is required.
  Compose still auto-loads an optional root `.env`; [`.env.example`](../../.env.example)
  documents the overridable knobs.
- Published ports are exactly three, all bound to `127.0.0.1`: `3000` (web), `3001` (API),
  `8025` (Mailpit web UI). PostgreSQL, Redis, Meilisearch, MinIO (API and console), and
  Mailpit SMTP have no host binding and sit on an `internal: true` `backend` network. The
  `api` and `mailpit` runtime services join the routable `edge` network to publish ports;
  the dependency installer and contract compiler use `edge` without publishing anything.
- [`docker/Dockerfile.dev`](../../docker/Dockerfile.dev) is one shared Node 22.23.1
  Debian-slim image (digest-pinned) with corepack-pinned pnpm 10.34.5, running as the
  non-root `node` user. It copies no application source: the repository arrives through a
  bind mount, so the image never rebuilds for a code change.
- `deps` is the only container that writes `node_modules`. It runs
  `pnpm install --frozen-lockfile --strict-peer-dependencies` then `pnpm build:packages`
  and exits. The persistent `contracts` service then watches both shared packages; the API
  and web wait for its initial healthy output, so shared source edits need no extra command.
- `db-init` runs `drizzle-kit migrate` on every start and seeds only on the first, guarded
  by a marker file on the `db-init-state` volume.
- [`docker/compose.debug-ports.yml`](../../docker/compose.debug-ports.yml) is an opt-in
  override that republishes the data-service ports for host-side tooling, wired up as
  `pnpm infra:up:ports`.
- [`scripts/dev-tooling.mjs`](../../scripts/dev-tooling.mjs) targets the new file, uses the
  fixed project name, no longer requires any environment file, waits on the full service
  graph, and runs `db:seed` inside the stack.

## Important Decisions

- **`web` shares the `api` container's network namespace (`network_mode: "service:api"`).**
  Server Components and route handlers in `apps/web/src/lib/*/server-*.ts` and
  `apps/web/src/app/api/shell/workspace/route.ts` fetch
  `publicEnvironment.NEXT_PUBLIC_API_URL` from *inside* the web container. That value must
  stay on the browser-facing API port because it is simultaneously the browser's API origin, the
  API's CORS allow-list entry, and a Better Auth trusted origin. Sharing the namespace
  makes that `localhost` port genuinely the API on both sides. The API's internal listening
  port follows `NOTTED_API_PORT`, so port overrides remain valid for server-side Next calls.
  The alternatives considered were
  a `socat` forwarder inside the web container (another moving part that can fail
  silently) and a server-only `API_INTERNAL_URL` override in
  `apps/web/src/config/public-environment.ts` (cleaner long-term, but eight-plus files and
  a real risk of leaking an internal URL into the browser bundle). The cost of the chosen
  option is that `ports` and `networks` are declared on `api`, and recreating `api`
  requires recreating `web`.
- **The repository bind mount is read-only and every writable path is a named volume.**
  This includes all `node_modules`, `apps/api/dist`, `apps/web/.next`, and both shared
  package `dist` directories. It prevents container tools from changing source and avoids
  any host uid/gid assumption. No volume declares `nocopy`: Docker seeds a fresh named
  volume from the *image* directory beneath it rather than from the host bind mount, and
  `docker/Dockerfile.dev` pre-creates every target owned by `node`, so each volume starts
  empty and correctly owned without a privileged chown one-shot.
  Tracked `.docker-mount` placeholders guarantee every nested target exists in a fresh
  clone before Docker applies the read-only parent bind.
  Nest's `deleteOutDir` is disabled and the API command clears the contents of its mounted
  output directory before starting, avoiding deletion of the mount point itself.
- **Seed-once uses a marker file, not a database probe or a marker table.** The seed in
  `apps/api/src/database/seed.ts` is already a conflict-aware upsert in a single
  transaction, so repeating it is safe; the guard exists only to stop it discarding a
  developer's edits to fixture rows. `db-init-state` shares its lifecycle with
  `postgres-data` under `docker compose down -v`, so the marker cannot outlive the database
  it describes, and no application code or migration was needed.
- **The Compose project name is the fixed `notted-dev`, not the previous
  `notted-dev-<checkout-path-hash>`.** A bare `docker compose up` cannot know about the
  hash, so keeping it would have produced two competing stacks. Worktree isolation is now
  opt-in through `COMPOSE_PROJECT_NAME`.
- **Container commands bypass the `apps/*` `dev`/`db:*` scripts.** Those scripts start with
  `node --env-file=.env …`, which hard-fails when `apps/api/.env` is absent — exactly the
  situation the zero-setup requirement creates. Compose injects the environment instead.
- **Only server-side dependency hosts differ from `apps/api/.env.example`.** Everything
  else keeps the default declared in `apps/api/src/config/*.config.ts`, so the config
  module stays the single source of truth and the Compose file stays readable.

## Files and Components

| Path | Purpose |
|---|---|
| `compose.yaml` | New. The whole development stack; fixed project name, contract watchers, read-only source, three published ports, inline defaults. |
| `docker/Dockerfile.dev` | New. Shared non-root Node 22.23.1 dev image; no source copied. |
| `docker/compose.debug-ports.yml` | New. Opt-in override republishing data-service ports for host tooling. |
| `.env.example` | New. Documents the optional root `.env` overrides. |
| `docker/docker-compose.dev.yml` | Deleted. Its services moved into `compose.yaml` with identical digests, healthchecks, and volumes. |
| `docker/.env.example` | Deleted. Its values are inline defaults in `compose.yaml`. |
| `scripts/dev-tooling.mjs` | Repointed at `compose.yaml`; fixed `PROJECT_NAME`; no `--env-file`; new exported `evaluateComposeReadiness`, `assertResetTarget`, `parseCommandOptions`, `parseComposeProcesses`; `db:seed` runs via `docker compose exec`. |
| `.gitignore`, `scripts/ensure-docker-mounts.mjs` | Track fresh-clone nested mount points and recreate them after host cleanup commands. |
| `scripts/dev-tooling.test.mjs` | Extended from 4 to 10 tests covering readiness evaluation, the reset target guard, option parsing, and `compose ps` output parsing. |
| `package.json`, `Makefile` | Added `infra:up:ports` / `make infra-up-ports`. |
| `apps/api/.env.example`, `apps/api/nest-cli.json` | Host-tooling environment notes and mounted-output-safe Nest cleanup. |
| `packages/shared-{types,validators}/package.json` | Persistent TypeScript watch commands used by the `contracts` service. |
| `docs/README.md`, `docs/environment.md`, `docs/legacy-development-volumes.md`, `README.md` | Onboarding, environment ownership, volume inventory, and repository overview updated. |

## Database and Data Changes

No schema, migration, or seed-content change. Migration *application* moved from the
manual `pnpm db:migrate` step into the `db-init` service, which runs `drizzle-kit migrate`
on every start. Seeding is unchanged in content and now runs automatically on first start
only.

Volume identity changed with the project name: the previous `notted-dev-<hash>_*` volumes
are orphaned rather than deleted, and existing development data does not carry over. This
is documented in `docs/README.md` and `docs/legacy-development-volumes.md`.

## API, Configuration, and Operational Changes

- No route, contract, or queue change.
- New optional root `.env` variables, all with defaults: `NOTTED_WEB_PORT`,
  `NOTTED_API_PORT`, `NOTTED_MAILPIT_WEB_PORT`, `NOTTED_POSTGRES_PORT`,
  `NOTTED_REDIS_PORT`, `NOTTED_MEILISEARCH_PORT`, `NOTTED_MINIO_API_PORT`,
  `NOTTED_MINIO_CONSOLE_PORT`, and `NOTTED_MAILPIT_SMTP_PORT`.
- `API_HOST` is `0.0.0.0` inside the container instead of the `127.0.0.1` development
  default. `readHost` in `apps/api/src/config/environment-readers.ts` accepts it, and the
  container is only reachable through the explicit `127.0.0.1:` port bindings.
- Published ports dropped from nine to three. Host-side `pnpm db:studio`, `pnpm db:check`,
  `pnpm db:generate`, and `pnpm test:ci` now require `pnpm infra:up:ports`.
- New `pnpm infra:up:ports` script and `make infra-up-ports` target. `pnpm env:init` no
  longer creates `docker/.env`; `pnpm env:check` no longer cross-validates it and succeeds
  when the host-side files are absent.
- Defaults are development-only. Nothing here targets production; Phase 15 Parts 79–84 still
  own production packaging.

## Security and Tenant-Isolation Notes

- The port surface is strictly smaller: PostgreSQL, Redis, Meilisearch, MinIO, and Mailpit
  SMTP move from `127.0.0.1`-published to an `internal: true` network with no host route.
- MinIO buckets stay private. The `minio-init` retry loop — `mc anonymous set none` on both
  buckets followed by a `grep -F private` verification — is carried over verbatim, per ADR
  0005.
- All images stay digest-pinned, including the new Node base, and both MinIO targets remain
  the reproducible source builds pinned to commit SHAs.
- Every container runs as non-root — `node` (uid 1000) for the workspace services and uid
  10001 for MinIO. The stack declares no `user: "0:0"` service at all.
- Development placeholder credentials are unchanged and remain clearly labelled as
  development-only. `apps/api/.env.example` now says explicitly that it does not configure
  the container stack.
- CORS and Better Auth trusted origins are unchanged, which is precisely why the
  `network_mode` decision above was taken rather than rewriting the origin values.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `node --test scripts/*.test.mjs` | Pass | 10/10 tests pass, including the six new ones. |
| YAML parse of `compose.yaml` and `docker/compose.debug-ports.yml` | Pass | Python/PyYAML parsed both files; Prettier also parsed and accepted both. |
| `pnpm lint` | Pass | All four workspaces and root ESLint configuration pass. |
| `pnpm type-check` | Pass | Six Turbo tasks pass, including both applications and shared packages. |
| `pnpm test` | Pass | Six Turbo tasks plus 10 developer-tooling tests pass; existing React `act(...)` warnings remain. |
| Focused environment/watch checks | Pass | API/web validators accept custom ports; both shared TypeScript watch commands start and compile with zero errors. |
| `pnpm format:check` | Pass | Includes `compose.yaml`; `.claude/settings.local.json` added to `.prettierignore` because the CLI rewrites it. |
| `pnpm build` | Pass | Requires production-secure `NEXT_PUBLIC_*` values; see the known limitation below. |

### 2026-08-04 runtime verification

Executed against Docker Desktop 29.6.2 on WSL 2, from a genuinely clean state
(`docker compose down --volumes --remove-orphans`, then `docker compose up --build`).

| Check | Result | Notes |
|---|---|---|
| `docker compose config` | Pass | Renders to 11 services; only `api` (3000, 3001) and `mailpit` (8025) declare ports. |
| `docker compose up --build` from empty volumes | Pass | `deps` → `db-init` → `contracts` → `api` → `web`; every one-shot exited 0 and every persistent service reported healthy. |
| Published port surface | Pass | 3000, 3001 and 8025 answer on `127.0.0.1`. |
| Unpublished port surface | Pass | 5432, 6379, 7700, 9000, 9001 and 1025 all refuse connection from the host. |
| `/health/ready` | Pass | HTTP 200 with all eight checks `up`: api, database, redis, minio, meilisearch, smtp and both email queues. |
| Migrations and first-run seed | Pass | Migrations applied; seed reported `users=6, workspaces=2, notes=9`. |
| Seed-once across a restart | Pass | Second start logged `Development seed already applied; skipping.` with seeded rows intact. |
| Server-rendered pages | Pass | `/`, `/login`, `/register` and `/workspaces` returned 200. |
| Shared network namespace | Pass | Inside the `web` container, a server-side `fetch` to `NEXT_PUBLIC_API_URL` (`http://localhost:3001`) returned 200 — the case that made `network_mode: "service:api"` necessary. |
| API hot reload | Pass | Source edit → `File change detected` → `Found 0 errors` → clean application restart. |
| Web fast refresh | Pass | Source edit → `✓ Compiled in 332ms`, page still 200. |
| MinIO bucket privacy (ADR 0005) | Pass | Both `notted-attachments` and `notted-exports` report `private`. |
| Volume ownership without any privileged one-shot | Pass | All workspace mounts `1000:1000`, MinIO `/data` `10001:10001`, from image copy-up alone. |
| `pnpm infra:up` / `infra:project` | Pass | Same `notted-dev` project as the bare CLI; readiness wait reported the stack ready. |

### 2026-08-04 registration and email-verification flow

Driven end to end against the running stack, cross-origin from `http://localhost:3000`:

| Step | Result | Notes |
|---|---|---|
| `POST /api/auth/sign-up/email` | Pass | HTTP 200, user created with `emailVerified: false`. CORS echoed `Access-Control-Allow-Origin: http://localhost:3000`. |
| Verification email delivered | Pass | Arrived in Mailpit as `Verify your Notted email` from `noreply@notted.local`, proving the Redis-backed queue, worker and SMTP-over-service-name all work. |
| Verification link followed | Pass | `GET /api/auth/verify-email?token=…` returned 302 to `/`. |
| Database state after verification | Pass | `email_verified=true` and the `afterEmailVerification` hook populated `email_verified_at`. |
| Sign-in after verification | Pass | `POST /api/auth/sign-in/email` returned 200; `GET /api/v1/auth/session` then returned an authenticated opaque session. |

The probe account, its session and account rows were deleted afterwards and Mailpit was
cleared, leaving the six seeded fixture users untouched.

## Known Limitations and Follow-up Work

- **`pnpm build` needs production-secure public URLs.** The gate runs
  `env:validate --production`, which rejects the `http://localhost` values a development
  `apps/web/.env.local` holds. This predates this change (it is recorded in the Part 08
  evidence table) and is a property of the host build gate, not the container stack.
- **`next dev` rewrites `apps/web/next-env.d.ts`.** Dev writes
  `./.next/dev/types/routes.d.ts`; `next build` writes `./.next/types/routes.d.ts`. The
  file is tracked, so running the stack shows it as modified until a build flips it back.
  This is upstream Next.js behaviour and happens on the host too; the only Docker-specific
  part is that the file must be mounted writable over the read-only source tree.
- **Seed identities cannot log in, by design.** The seed creates no `account` rows,
  passwords, sessions or verification tokens. Registering a development account through
  `/register` and confirming it in Mailpit is the supported path, and is what the flow
  verification above exercises.
- **Recreating `api` requires recreating `web`,** a direct consequence of the shared network
  namespace. `docker compose up -d` handles it; `docker compose restart api` alone does not.
- **A server-only `API_INTERNAL_URL` is the cleaner long-term fix** for the web-to-API
  server-side fetch, and would remove the shared-namespace coupling. Deferred as an
  application-code change.
- **MinIO will need a browser-reachable endpoint** once attachments and exports land — no
  `presignedGetObject` call exists in `apps/api/src` today, which is the only reason port
  9000 can stay unpublished. Either publish it or proxy object reads through the API at
  that point. A comment in `compose.yaml` marks the spot.
- **Existing development data is orphaned** by the project-name change; see the volume
  inventory in `docs/legacy-development-volumes.md`.
- **Host-side database tooling now needs an extra step** (`pnpm infra:up:ports`), which is a
  deliberate trade for the smaller port surface.
