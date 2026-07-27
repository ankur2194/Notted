# Notted

Notted is a planned corporate-grade, self-hosted notes and knowledge-management platform. It combines a clean A4/Letter paper-style writing experience with project organization, rich-text editing, task management, attachments, search, collaboration, exports, and optional AI assistance.

The project is designed as a portfolio-quality full-stack SaaS system using open-source infrastructure and deployable through Docker Compose.

> **Project status:** Planning and engineering standards are established. Product implementation is organized into the numbered parts in [`Plan.md`](Plan.md); application features should not be considered complete until their corresponding completion records exist.

## Product Vision

Notted is intended to support both standalone notes and project-based knowledge organization within multi-user workspaces. Its central writing surface resembles physical white paper, with A4 and Letter sizing, configurable margins, zoom controls, page-break visualization, focus mode, and clean printing.

Planned capabilities include:

- Rich-text editing powered by TipTap
- A4 and Letter paper layouts with print-ready output
- Workspaces, roles, projects, standalone notes, nesting, tags, and templates
- Inline checklists and structured task-list notes
- Clipboard, drag-and-drop, and file-picker image uploads
- General attachments stored in private object storage
- Note history, comparison, and non-destructive restoration
- Full-text and semantic search
- Real-time presence, collaborative editing, and inline comments
- PDF, HTML, Markdown, DOCX, and text exports
- Optional AI summarization, rewriting, extraction, tagging, and writing assistance
- API keys, REST APIs, signed webhooks, audit logs, and workspace branding
- Self-hosted deployment, backups, observability, and recovery procedures

The complete product specification is maintained in [`Notted.md`](Notted.md).

## Planned Technology Stack

| Area | Technology |
|---|---|
| Web application | Next.js, React, TypeScript, Tailwind CSS, Shadcn UI |
| Editor | TipTap and ProseMirror extensions |
| Backend | NestJS and TypeScript |
| First-party API | tRPC |
| Public API | Versioned REST endpoints |
| Database | PostgreSQL with Drizzle ORM |
| Semantic search | pgvector |
| Full-text search | Meilisearch |
| Authentication | Better Auth |
| Cache and messaging | Redis |
| Background processing | BullMQ and Bull Board |
| File storage | MinIO and Sharp |
| Realtime collaboration | Socket.io and Yjs |
| Email | Nodemailer and React Email |
| Export | Puppeteer and document conversion libraries |
| Deployment | Docker, Docker Compose, and a TLS reverse proxy |

Exact versions must be compatibility-tested and pinned during the relevant foundation parts rather than inferred from this overview.

## Planned Repository Structure

```text
Notted/
├── apps/
│   ├── web/                    # Next.js application
│   └── api/                    # NestJS API and workers
├── packages/
│   ├── shared-types/           # Shared TypeScript contracts
│   └── shared-validators/      # Shared Zod schemas
├── docker/                     # Development and production Compose files
├── scripts/                    # Setup, deployment, migration, backup, restore
├── docs/
│   ├── completed-parts/        # Durable cross-session implementation records
│   ├── decisions/              # Architecture decision records
│   └── standards/              # Project-wide engineering standards
├── .agents/
│   ├── skills/                 # Reusable Notted development skills
│   └── checklists/             # Completion gates
├── .codex/
│   ├── config.toml             # Project-scoped Codex agent settings
│   └── agents/                 # Codex custom agent definitions
├── .opencode/
│   ├── agent/                  # opencode custom agent definitions
│   └── command/                # opencode slash commands
├── opencode.json               # Project-scoped opencode config
├── AGENTS.md                   # Governing agent instructions
├── Notted.md                   # Primary product and structure specification
└── Plan.md                     # Sequential implementation plan
```

The detailed target layout in [`Notted.md`](Notted.md) is authoritative when implementation begins.

## Architecture Principles

- [`Notted.md`](Notted.md) owns product requirements and canonical project structure.
- [`Plan.md`](Plan.md) owns implementation order and completion criteria.
- Next.js Server Components are preferred unless browser interactivity requires a client component.
- tRPC serves the first-party web application; versioned REST serves external integrations.
- Both transports call the same NestJS application services and authorization policies.
- PostgreSQL is the authoritative business-data store.
- Redis is ephemeral infrastructure, while Meilisearch and vector embeddings are rebuildable projections.
- Every tenant-owned operation must be authenticated, authorized, and workspace-scoped on the backend.
- MinIO buckets remain private; downloads use authorization or expiring signed URLs.
- Database changes require reviewed Drizzle migrations.
- Each feature is delivered with relevant tests, security review, documentation, and operational consideration.

More detailed rules are available in [`docs/standards/`](docs/standards/).

## Development Workflow

Development is divided into 88 small, dependency-ordered parts in [`Plan.md`](Plan.md). Each part should normally be completed in a separate agent session.

The shortest recommended Codex workflow is:

```text
$notted-part-delivery Part 1 implement
$notted-quality-operations Review Part 1
$notted-quality-operations Verify Part 1 full
$notted-part-delivery Part 1 handoff
```

These project skills load from `.agents/skills/`. `AGENTS.md` routes relevant work to the custom agents configured under `.codex/agents/`.

Delegated agent work is synchronous at every nesting level. The governing protocol in `AGENTS.md` requires a finite supported blocking wait, terminal completion payloads, one parent review/merge pass, and explicit handling of failed, blocked, or timed-out subagents.

After cloning or changing Codex configuration, trust the project when Codex prompts you and start a new Codex chat so project agents and skills are reloaded.

### Using opencode

The same workflow runs on opencode. Skills are discovered natively from `.agents/skills/` (an opencode-supported path), agents live in `.opencode/agent/`, and the `$skill` invocations become slash commands in `.opencode/command/`:

```text
/notted-part-delivery Part 1 implement
/notted-quality-operations Review Part 1
/notted-quality-operations Verify Part 1 full
/notted-part-delivery Part 1 handoff
```

- `/notted-part-delivery Part <number> plan` plans without editing.
- `/notted-part-delivery Part <number> implement` implements the selected part.
- `/notted-part-delivery Part <number> resume` resumes unfinished work.
- `/notted-quality-operations Review Part <number>` performs an independent read-only review.
- `/notted-quality-operations Verify Part <number> full` runs the applicable completion gate.
- `/notted-part-delivery Part <number> handoff` writes the durable completion record.

After changing `opencode.json`, `.opencode/agent/`, or `.opencode/command/`, restart opencode so the configuration is reloaded.

### Codex commands

- `$notted-part-delivery Part <number> plan` plans without editing.
- `$notted-part-delivery Part <number> implement` implements the selected part.
- `$notted-part-delivery Part <number> resume` resumes unfinished work.
- `$notted-quality-operations Review Part <number>` performs an independent read-only review.
- `$notted-quality-operations Verify Part <number> full` runs the applicable completion gate.
- `$notted-part-delivery Part <number> handoff` writes the durable completion record.

## Completion Records

Every completed plan part has one record under [`docs/completed-parts/`](docs/completed-parts/). A record documents:

- Delivered behavior and boundaries
- Important technical decisions and deviations
- Changed files and components
- Database migrations and data impact
- API, configuration, and operational changes
- Security and tenant-isolation considerations
- Exact verification commands and results
- Known limitations and follow-up work
- Guidance for the next agent or session

A part is not complete merely because code exists. Its stated criteria and required verification must pass, and its completion record and index must be current.

## Current Documentation

| Document | Purpose |
|---|---|
| [`Notted.md`](Notted.md) | Full product, architecture, feature, schema, infrastructure, and deployment specification |
| [`Plan.md`](Plan.md) | Detailed sequential development plan and completion criteria |
| [`AGENTS.md`](AGENTS.md) | Mandatory instructions for development agents |
| [`CLAUDE.md`](CLAUDE.md) | Concise coding conventions for compatible coding assistants |
| [`docs/standards/`](docs/standards/) | Architecture, frontend, backend, database, API, security, testing, observability, and operations standards |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records |
| [`docs/completed-parts/`](docs/completed-parts/) | Cross-session implementation and verification history |
| [`docs/database-migrations.md`](docs/database-migrations.md) | Drizzle migration generation, immutability, testing, and rollback policy |

## Local Development

The host-run applications and checkout-isolated development infrastructure are available:

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm env:init
pnpm env:check
pnpm infra:up
pnpm db:migrate
pnpm dev
```

Common commands include `pnpm dev:api`, `pnpm dev:web`, `pnpm infra:status`,
`pnpm infra:project`, `pnpm infra:logs`, `pnpm infra:down`, `pnpm build`, `pnpm lint`,
`pnpm type-check`, `pnpm test`, `pnpm db:check`, `pnpm db:generate`,
`pnpm db:migrate`, and `pnpm db:studio`. `pnpm db:seed` intentionally exits
non-zero until Part 20; there are no seed or first-login credentials yet. Volume deletion
is available only through the guarded `pnpm infra:reset:dev` command.

See [`docs/README.md`](docs/README.md) for exact onboarding, ports, migration flow,
Docker Desktop/WSL troubleshooting, and shutdown/reset safety. Environment ownership and
production requirements are documented in
[`docs/environment.md`](docs/environment.md).
Legacy fixed-project development volumes are covered by the non-destructive
[`docs/legacy-development-volumes.md`](docs/legacy-development-volumes.md) recovery
runbook.

## Security and Privacy

Notted is intended for corporate and potentially sensitive note content. Security requirements therefore include backend-enforced role-based access, strict tenant isolation, private object storage, validated inputs, rate limiting, redacted logs, secure session handling, encrypted provider credentials, signed webhooks, and negative authorization tests.

Please report security concerns privately to the repository owner rather than publishing exploitable details in a public issue. A formal security policy and reporting channel should be added before public release.

## Deployment

The target deployment is a self-hosted Linux server running Docker Compose behind Nginx or Traefik with TLS. Production readiness includes pinned non-root images, private infrastructure networking, health checks, safe migrations, structured observability, encrypted off-host backups, and tested restoration.

Deployment instructions will become authoritative only after the production packaging and operations parts in [`Plan.md`](Plan.md) have been completed and verified.

## Contributing

Before contributing:

1. Read [`AGENTS.md`](AGENTS.md), the relevant section of [`Notted.md`](Notted.md), and the selected [`Plan.md`](Plan.md) part.
2. Read prerequisite completion records and applicable standards.
3. Keep changes within one numbered part unless broader scope is explicitly approved.
4. Preserve unrelated work and follow established project patterns.
5. Add appropriate tests and document actual verification results.
6. Complete the [part checklist](.agents/checklists/part-completion.md) and handoff record.

## License

No project license has been selected yet. Until a license file is added, all rights remain with the project owner. Third-party dependencies retain their respective licenses.
