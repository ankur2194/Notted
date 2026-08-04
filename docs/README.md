# Local development

## Prerequisites

Required:

- Docker Engine/Desktop with Docker Compose v2 and BuildKit
- Git

Optional, for host-side tooling and the quality gates only:

- Node.js `22.23.1` (minimum supported `22.12.0`, Node 23+ is outside the baseline)
- Corepack with pnpm `10.34.5`

On Windows, use WSL 2 integration and keep Docker Desktop running. A repository on an
NTFS-mounted `/mnt/*` path works but TypeScript/Vitest file traversal can be slower than a
WSL-native filesystem, and container file watching may need `WATCHPACK_POLLING=true`. If
Docker commands fail from WSL, enable integration for that distribution and verify
`docker info` before changing project files.

## Clone to running

```bash
docker compose up
```

That is the whole setup. The stack in [`compose.yaml`](../compose.yaml) installs workspace
dependencies, builds the shared contract packages, applies every Drizzle migration, seeds
the deterministic fixture on first run, continuously rebuilds shared contracts, and starts
the API and web app with hot reload. Source is mounted read-only; dependencies and generated
outputs use Docker volumes, so host uid/gid does not affect startup. No environment file,
host toolchain, or follow-up command is required.

Expect the first run to take several minutes: it builds the two source-pinned MinIO
binaries and performs a full `pnpm install`. Follow it with `docker compose logs -f deps`.
Subsequent runs reuse the pnpm store and dependency volumes.

The equivalent wrapper waits for readiness and names the service holding it up:

```bash
pnpm infra:up
```

Neither path needs `pnpm env:init`. That command now only creates `apps/api/.env` and
`apps/web/.env.local` for *host-side* tooling such as `pnpm db:studio` and `pnpm test:ci`.

### Running the applications on the host instead

Still supported, but no longer the default. The data services have no published ports, so
start the stack with the override below, then run the apps yourself:

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm env:init
pnpm env:check
pnpm infra:up:ports
pnpm build:packages
docker compose stop api web
pnpm dev
```

### Deterministic development seed

The `db-init` service applies migrations on every start and runs the seed only on the
first normal stack start, guarded by a marker on the `db-init-state` volume. Both volumes
are deleted together by the documented reset. If either volume is manually removed or
restored independently, remove the other one too or run `pnpm db:seed` after startup.

Reseed on demand — for example after editing fixture rows:

```bash
pnpm db:seed
```

That executes the seed inside the running `api` container. Rerunning it is safe: every
canonical row has a stable UUID, mutable fixture fields are restored with conflict-aware
upserts, and composite junction rows ignore an already-present pair. It does not truncate
tables or delete developer-created rows.

Seed target safety is enforced again inside the API seed entry point. It always refuses
`NODE_ENV=production`. By default the parsed database name must be exactly `notted_dev`
or explicitly Notted-prefixed test/review-like (for example `notted_test`,
`notted_test_42`, or `notted_phase3_review`). An exceptional non-production target requires the exact opt-in
`ALLOW_UNSAFE_DATABASE_SEED=true`; this override never permits production. Refusal
messages do not print `DATABASE_URL`, usernames, passwords, hosts, or other credentials.

The stable scenarios are **Alpha isolation tenant** (`Notted Alpha Studio`) and **Beta
isolation tenant** (`Notted Beta Workshop`). Alpha has owner, admin, editor, and viewer
members plus projects, hierarchical notes/folders, task data, tags, comments, versions,
and attachment metadata. Beta has distinct members and content specifically for negative
tenant-isolation checks. The attachment rows are metadata only; no object bytes, public
URLs, or signed URLs are created.

Seed identities use reserved `.test` addresses, but they are **not login credentials**.
No passwords, password hashes, sessions, verification tokens, TOTP secrets, passkeys, or
login claims are seeded. Register a separate development account at
`http://localhost:3000/register`; the verification message is captured by Mailpit at
`http://localhost:8025`. Seed users remain relational fixtures and must not be given
fabricated account rows or passwords.

### Local authentication and Mailpit

Better Auth is mounted outside the versioned API at `/api/auth`. Email/password
registration and sign-in use `/sign-up/email` and `/sign-in/email`; verification resend is
`/send-verification-email`; magic-link request is `/sign-in/magic-link`. Notted's
hash-at-rest reset endpoints are `/notted/request-password-reset` and
`/notted/reset-password`. The web routes are `/login`, `/register`, `/forgot-password`,
`/reset-password`, `/verify-email`, and `/magic-link`. Browser requests use the official
Better Auth client with credentialed opaque cookies; Server Components forward only the
incoming cookie header to `GET /api/v1/auth/session`. Direct local API requests must include
`Origin: http://localhost:3000` and use cookies rather than bearer tokens.

Part 23 adds `/two-factor` for login challenges and the protected canonical user security
page `/settings/security`. Better Auth remains the only credential/session authority: TOTP
secrets and encrypted recovery codes remain server-side, WebAuthn uses
`@better-auth/passkey@1.6.24`, and active-session responses omit raw tokens, IP addresses,
credential IDs, and public keys. High-risk actions prompt for recent authentication and clear
password fields immediately. Passkey controls explain unsupported browser/insecure-context
states; local WebAuthn works only on `http://localhost`, while production requires HTTPS and
the exact RP ID/origin contract in [`environment.md`](environment.md).

OAuth is optional. With no provider tuples configured, password, magic-link, and passkey
controls remain available and no empty OAuth controls render. To enable a provider, configure
its complete server-only tuple in `apps/api/.env`, register the corresponding Better Auth
callback URL, run `pnpm env:check`, and restart the API. Never copy provider credentials into
the web environment or test mocks.

Authentication email is committed to PostgreSQL before identifier-only BullMQ dispatch.
Mailpit may therefore receive it shortly after the request returns. Delivery rows contain
status and recipient only; tokenized URLs are AES-256-GCM encrypted until the worker
decrypts/renders them in memory. Redis is required for Better Auth session lookup and the
queue. Redis loss fails closed and can require sign-in again even though PostgreSQL retains
the durable session row; see ADR 0010.

### Dashboard shell and notifications

The protected application shell loads `GET /api/v1/shell/bootstrap` in a Server Component.
It returns only the current user summary, live workspace memberships and roles, a
server-validated current workspace, safe presentation hints derived from the Part 24 policy,
and the current workspace's unread notification count. The workspace selector posts to the
minimal same-origin `/api/shell/workspace` adapter; that adapter asks NestJS to validate the
selection against current membership before storing an HTTP-only selector cookie. A workspace
UUID is never authority.

Notification history and read state are PostgreSQL-backed at
`/api/v1/workspaces/:workspaceId/notifications`. The center supports bounded pages, mark one
read/unread, and atomic mark-all-read. Browser storage is not used for memberships,
notification payloads, read state, sessions, or permissions. Only the validated
expanded/collapsed sidebar preference is stored in `localStorage`.

For the Part 25 Playwright journeys, provision a dedicated non-seed login fixture with two
workspace memberships and safe notification rows, then set `PLAYWRIGHT_SHELL_EMAIL` and
`PLAYWRIGHT_SHELL_PASSWORD`. Never commit those values. The suite skips fixture-dependent
journeys when they are absent; it does not install browser binaries. Search remains an
accessible placeholder until Parts 50–52, note-tree content until Parts 31–32, workspace
lifecycle until Part 26, and notification production/mention behavior until Part 60.

## Services and ports

Only three ports are published, all bound to `127.0.0.1`:

| Service     | Loopback URL            | Health or use                   |
| ----------- | ----------------------- | ------------------------------- |
| Web         | `http://localhost:3000` | Next.js application             |
| API         | `http://localhost:3001` | `/health/live`, `/health/ready` |
| Mailpit web | `http://localhost:8025` | Captured messages               |

Use the `localhost` spelling, not `127.0.0.1`, even though the ports are published on
`127.0.0.1` and Docker Desktop's port link opens that address. The stack is configured for a
single browser origin — `APP_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, and the `NEXT_PUBLIC_*` values
in `compose.yaml` all name `http://localhost:3000` — so the API rejects `http://127.0.0.1:3000`
at the CORS and CSRF origin checks and sign-in fails. The two spellings cannot both work:
`NEXT_PUBLIC_API_URL` compiles to one value, and a `SameSite=Lax` session cookie is not sent from
a `127.0.0.1` page to a `localhost` API, so widening CORS alone would still leave sessions
broken. `apps/web/next.config.js` does allow `127.0.0.1` as a Next development origin, which only
keeps the page interactive enough to report that CORS error instead of failing silently; see the
troubleshooting entry below.

Everything else is reachable only from inside the stack, by Compose service name:

| Service       | In-cluster address      | Health or use              |
| ------------- | ----------------------- | -------------------------- |
| PostgreSQL    | `postgres:5432`         | Drizzle database           |
| Redis         | `redis:6379`            | Cache/realtime foundation  |
| Meilisearch   | `http://meilisearch:7700` | `/health`                |
| MinIO API     | `http://minio:9000`     | Private object API         |
| MinIO console | `http://minio:9001`     | Development administration |
| Mailpit SMTP  | `mailpit:1025`          | Development SMTP capture   |

They sit on an `internal` Compose network with no route to or from the host. The `api`,
`web` (which shares the API container's network namespace), and `mailpit` runtime services
also use the routable `edge` network because they publish ports. The dependency installer
and contract compiler use `edge` without publishing anything.

Change a published port through a root `.env` — copy [`.env.example`](../.env.example).
Changing `NOTTED_WEB_PORT` or `NOTTED_API_PORT` also rewrites `APP_URL`, `API_URL`,
`WS_URL`, the CORS allow-list, and the `NEXT_PUBLIC_*` origins together, so the browser
and the API cannot drift apart.

### Host tooling and the debug-ports override

Anything on the host that opens a socket to a data service needs
[`docker/compose.debug-ports.yml`](../docker/compose.debug-ports.yml), which republishes
PostgreSQL, Redis, Meilisearch, MinIO, and Mailpit SMTP on `127.0.0.1`:

```bash
pnpm infra:up:ports
# or: docker compose -f compose.yaml -f docker/compose.debug-ports.yml up -d
```

That is required for `pnpm db:studio`, `pnpm db:check`, the MinIO console, and host
`pnpm test:ci`. The alternative that needs no host prerequisites is to run the command
inside the stack, for example `docker compose exec api pnpm test`.

## Infrastructure lifecycle

```bash
docker compose up          # or: pnpm infra:up
pnpm infra:project
pnpm infra:status
pnpm infra:logs
pnpm infra:down
```

The Compose project name is the fixed `notted-dev` declared by `name:` in `compose.yaml`,
so `docker compose` and the `pnpm infra:*` wrappers always address the same containers and
volumes. Worktrees no longer get their own volume set automatically. An isolated worktree
may export `COMPOSE_PROJECT_NAME` only when it uses bare `docker compose` commands
consistently; the `pnpm infra:*` wrappers deliberately target the fixed `notted-dev` stack.

> **Upgrading an existing checkout:** the old per-checkout `notted-dev-<hash>` project is
> not reused, so its volumes are orphaned rather than deleted. Inspect them with
> `docker volume ls --filter name=notted-dev-` and remove them once you no longer need the
> data.

`pnpm infra:up` builds the two source-pinned MinIO targets and the shared dev image, waits
up to 900 seconds (a first run installs the whole workspace), and fails fast naming any
one-shot service — `deps`, `db-init`, `minio-init` — that exited
non-zero. It also waits for the persistent shared-contract compiler and both applications.
Normal shutdown preserves data volumes.

If exact legacy `notted-dev_notted_*_dev_data` volumes are present, startup warns and
leaves them untouched. Follow
[`legacy-development-volumes.md`](legacy-development-volumes.md) to inventory, back up,
recover, verify, and retain rollback data before any reset.

The only volume-deleting command is:

```bash
pnpm infra:reset:dev
```

It targets only the root `compose.yaml` and the exact `notted-dev` project, refuses
production, ambient Compose/Docker overrides, and non-local Docker endpoints, and
requires typing exactly
`DELETE NOTTED DEV DATA`. It never runs a global Docker prune.

## Database workflow

```bash
pnpm db:seed                 # runs inside the api container
pnpm infra:up:ports          # required by everything below
pnpm db:check
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

`db:generate` and `db:check` are host `drizzle-kit` commands and need `apps/api/.env` plus
a reachable database, so run `pnpm env:init` and `pnpm infra:up:ports` first. Routine
migration *application* needs neither: the `db-init` service already applies migrations on
every `docker compose up`.

Review generated migrations before committing and never edit a deployed migration.
`db:seed` requires migrations `0000`–`0007` and fails with a safe message when they are
absent. It never changes schema or migration history. Part 12's initial extension
migration and all accepted migrations remain immutable.
The full generation, review, application, testing, immutability, and rollback policy is
in [`database-migrations.md`](database-migrations.md).

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm type-check
pnpm test
pnpm test:ci
pnpm test:e2e
pnpm build
pnpm audit:prod
```

`pnpm test:ci` adds coverage and enforces a 70% threshold on statements, branches,
functions, and lines in every workspace. **It requires a reachable PostgreSQL database.**
The API's integration suites are gated on `DATABASE_URL` (`describe.skipIf`) and run their
own migrations and seed against it. Without one they all skip, and `apps/api` lands near
55% — well under the threshold — so the command fails with only coverage numbers to
explain why. Run `pnpm infra:up:ports` first so PostgreSQL is reachable from the host;
`apps/api/.env` already points `DATABASE_URL` at the published instance. Plain `pnpm test`
has no threshold and needs no database. CI provisions its own throwaway `pgvector` service
for this reason.

Those suites commit rather than rolling back, because their barrier-synchronized races need
genuinely independent transactions. They clean up their own committed rows on the next run,
so a long-lived development database stays usable, but a truly clean run is what CI gets.

`pnpm test:e2e` uses exact `@playwright/test@1.62.0` and expects the running stack — it
drives `http://localhost:3000`, `http://localhost:3001`, and Mailpit on
`http://localhost:8025`, all of which the default `docker compose up` publishes. Install
browser binaries
separately when needed with `pnpm --filter @notted/web exec playwright install`; browser
binaries are not installed by dependency installation and are not committed. The suite
creates fresh `.test` accounts and never relies on seed credentials.

The root `Makefile` is an optional thin alias layer (`make infra-up`, `make test`,
`make db-migrate`, and so on); pnpm scripts are canonical and cross-platform.

## Troubleshooting

- If the apps never start, read `docker compose logs deps` first. Dependency installation
  is the one step everything else waits on.
- If a port is occupied, set `NOTTED_WEB_PORT`, `NOTTED_API_PORT`, or
  `NOTTED_MAILPIT_WEB_PORT` in a root `.env`, then `pnpm infra:down` and `pnpm infra:up`.
  The dependent URLs follow automatically.
- Use `pnpm infra:status` before reading logs. `deps`, `minio-init`, and `db-init` should
  be exited with code 0; persistent services including `contracts` should be healthy.
- Source is read-only in containers. Dependency and build-output volumes take their
  ownership from the image directory underneath them, so a write error inside a container
  usually means a volume survived from an older image — `pnpm infra:reset:dev` clears it.
- Changes to `packages/shared-*` are rebuilt by the persistent `contracts` service. The
  API and web watchers consume its generated output without another command.
- The `web` container shares the `api` container's network namespace, so recreating `api`
  requires recreating `web`. `docker compose up -d` does both.
- Run `pnpm env:check` after editing the host-side environment files. It reports variable
  names and safe categories, never values.
- If a form reloads the page with its field values in the query string, the page never
  hydrated: React is not intercepting the submit, so the browser is performing the plain HTML
  submit. Check the browser origin first. Next blocks cross-origin access to `/_next/*`
  development resources, which includes the HMR socket that the Turbopack client runtime waits
  on before it hydrates, and the dev server logs `Blocked cross-origin request to Next.js dev
  resource`. `apps/web/next.config.js` allows the loopback addresses; any other host — a LAN
  address, a container IP, a tunnel hostname — reproduces this with no error in the browser.
- If registration or sign-in reports that the request could not be completed and the browser
  console shows a CORS failure naming `Access-Control-Allow-Origin`, the page origin does not
  match the configured one. Open `http://localhost:3000` rather than `http://127.0.0.1:3000`
  or a LAN address; see "Services and ports" for why only one spelling works.
- Attributes such as `data-gr-ext-installed` or `cz-shortcut-listen` in a hydration mismatch
  come from browser extensions (Grammarly, ColorZilla) editing `<body>` before React loads, not
  from application code. `apps/web/src/app/layout.tsx` sets `suppressHydrationWarning` on that
  one element; mismatches inside the application tree are still reported.
- Docker Desktop file sharing/build failures usually mean the workspace drive or WSL
  distribution is not enabled. Source-based MinIO builds also require registry and GitHub
  access on first build.
- Public web variables are build-time values. After changing any
  `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, or `NEXT_PUBLIC_WS_URL`, rebuild/restart
  the web app; do not expect a deployed bundle to read runtime replacements.

Variable ownership and production rules are detailed in
[`environment.md`](environment.md).
