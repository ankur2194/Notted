# Local development

## Prerequisites

- Node.js `22.23.1` (minimum supported `22.12.0`, Node 23+ is outside the baseline)
- Corepack with pnpm `10.34.5`
- Docker Engine/Desktop with Docker Compose v2 and BuildKit
- Git

On Windows, use WSL 2 integration and keep Docker Desktop running. A repository on an
NTFS-mounted `/mnt/*` path works but TypeScript/Vitest file traversal can be slower than a
WSL-native filesystem. If Docker commands fail from WSL, enable integration for that
distribution and verify `docker info` before changing project files.

## Clone to running

```bash
corepack enable
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm env:init
pnpm env:check
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`env:init` creates only missing `docker/.env`, `apps/api/.env`, and
`apps/web/.env.local`; it never overwrites an existing file. The API development launcher
explicitly loads `apps/api/.env`. Next.js loads `apps/web/.env.local` using native
precedence.

The root `dev` command runs API and web through Turborepo. Use `pnpm dev:api` or
`pnpm dev:web` separately.

### Deterministic development seed

Run the seed only after healthy infrastructure and all migrations are present:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` validates the development environment, loads `apps/api/.env`, and writes
the complete fixture atomically through PostgreSQL. Rerunning the command is safe: every
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
login claims are seeded. Part 21 will provide the supported development login flow after
Better Auth is integrated; until then the relationships are browsable through database
integration tests rather than an authenticated UI/API session.

## Services and ports

| Service       | Loopback URL/port       | Health or use                   |
| ------------- | ----------------------- | ------------------------------- |
| Web           | `http://localhost:3000` | Next.js application             |
| API           | `http://localhost:3001` | `/health/live`, `/health/ready` |
| PostgreSQL    | `127.0.0.1:5432`        | Drizzle database                |
| Redis         | `127.0.0.1:6379`        | Cache/realtime foundation       |
| Meilisearch   | `http://localhost:7700` | `/health`                       |
| MinIO API     | `http://localhost:9000` | Private object API              |
| MinIO console | `http://localhost:9001` | Development administration      |
| Mailpit SMTP  | `127.0.0.1:1025`        | Development SMTP capture        |
| Mailpit web   | `http://localhost:8025` | Captured messages               |

Override published ports only in `docker/.env`, then update corresponding API host
endpoints. All ports bind to `127.0.0.1`.

## Infrastructure lifecycle

```bash
pnpm infra:up
pnpm infra:project
pnpm infra:status
pnpm infra:logs
pnpm infra:down
```

Each checkout derives `notted-dev-<workspace-path-hash>` as its Compose project name, so
containers and volumes do not collide across worktrees. Startup builds the two
source-pinned MinIO targets, waits at most 180 seconds for health, and verifies the
one-shot bucket initializer. Normal shutdown preserves data volumes.

If exact legacy `notted-dev_notted_*_dev_data` volumes are present, startup warns and
leaves them untouched. Follow
[`legacy-development-volumes.md`](legacy-development-volumes.md) to inventory, back up,
recover, verify, and retain rollback data before any reset.

The only volume-deleting command is:

```bash
pnpm infra:reset:dev
```

It targets only the canonical development Compose file and derived project, refuses
production, ambient Compose/Docker overrides, and non-local Docker endpoints, and
requires typing exactly
`DELETE NOTTED DEV DATA`. It never runs a global Docker prune.

## Database workflow

```bash
pnpm db:check
pnpm db:generate
pnpm db:migrate
pnpm db:studio
pnpm db:seed
```

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
pnpm build
pnpm audit --prod --audit-level=high
```

The root `Makefile` is an optional thin alias layer (`make infra-up`, `make test`,
`make db-migrate`, and so on); pnpm scripts are canonical and cross-platform.

## Troubleshooting

- Run `pnpm env:check` after editing configuration. It reports variable names and safe
  categories, never values.
- If a port is occupied, edit only its published port in `docker/.env`, update the API
  endpoint if needed, then run `pnpm infra:down` and `pnpm infra:up`.
- Use `pnpm infra:status` before reading logs. `minio-init` should be exited with code 0;
  persistent services should be healthy.
- Docker Desktop file sharing/build failures usually mean the workspace drive or WSL
  distribution is not enabled. Source-based MinIO builds also require registry and GitHub
  access on first build.
- Public web variables are build-time values. After changing any
  `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, or `NEXT_PUBLIC_WS_URL`, rebuild/restart
  the web app; do not expect a deployed bundle to read runtime replacements.

Variable ownership and production rules are detailed in
[`environment.md`](environment.md).
