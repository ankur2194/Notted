# Notted Development Plan

This document turns the specification in `Notted.md` into a dependency-ordered implementation plan. Each numbered part is intended to be a small, independently verifiable unit of work. Complete the parts sequentially unless a step explicitly says it can be done in parallel.

## Completion Records

After completing any numbered part, create or update its permanent summary in [`docs/completed-parts/`](docs/completed-parts/README.md). Name each record `part-NN-short-name.md`, using the zero-padded plan number—for example, `part-01-architecture-decisions.md`. Start from [`docs/completed-parts/TEMPLATE.md`](docs/completed-parts/TEMPLATE.md).

A part is not considered complete until its record states what was implemented, identifies important decisions and deviations, lists changed files and migrations, records verification commands and results, and describes any remaining risks or follow-up work. Future agents and sessions must read the completion records for prerequisite parts before starting new work. Completion records are historical handoff documents: update them to correct facts or append later discoveries, but do not erase relevant decisions or known limitations.

## Working Principles and Definition of Done

- Keep the repository runnable at the end of every part; do not merge a step that breaks builds, migrations, or existing tests.
- Use TypeScript strict mode everywhere. Share domain types and Zod validation instead of duplicating request contracts.
- Treat workspace isolation and authorization as backend invariants, never merely as hidden frontend controls.
- Add tests with each behavior rather than postponing all tests until the end.
- A feature is complete only when its success path, empty/loading/error states, authorization, observability, and relevant documentation are covered.
- Start with a thin end-to-end product slice, then add advanced capabilities. Optional integrations such as AI must degrade cleanly when they are not configured.
- Pin deployable dependency and container versions after compatibility testing; do not rely on floating `latest` tags in production.

## Phase 1 — Product Decisions and Repository Foundation

### Part 1 — Record architecture decisions and resolve specification gaps

Create `docs/decisions/` and write short architecture decision records for the monorepo, API boundary, authentication ownership, collaboration model, storage model, and background workers. Resolve the brief's overlap between tRPC and REST by defining tRPC as the first-party web application's typed interface and versioned REST as the public/integration API, both calling the same NestJS application services. Decide that Yjs provides collaborative document state while Socket.io supplies transport, presence, and non-document events.

Also document schema gaps that must be added later: standalone task entities, project membership or project-level access, note ordering, folders, note sharing, invitations, sessions, webhooks and deliveries, AI configuration/usage, email delivery status, and export records. Record the supported Node and pnpm versions and validate that the chosen versions of Next.js, NestJS, Better Auth, tRPC, Drizzle, TipTap, React, and supporting packages are mutually compatible.

**Complete when:** the decisions explain ownership boundaries, data flow, tenancy, and the source of truth for collaborative documents; unresolved product questions are explicitly listed with safe defaults.

### Part 2 — Initialize the pnpm/Turborepo monorepo

Create the root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, shared TypeScript base configuration, `.gitignore`, `.dockerignore`, EditorConfig, and Node-version file. Create `apps/web`, `apps/api`, `packages/shared-types`, and `packages/shared-validators`. Add root scripts for development, build, lint, type-check, test, formatting, migration, and clean operations. Configure Turborepo task dependencies and cache outputs so package builds happen before dependent application builds.

**Verify:** a clean install succeeds; root lint, type-check, test, and build scripts run across all empty/scaffolded workspaces.

### Part 3 — Establish formatting, linting, and commit quality gates

Configure ESLint for Next.js, NestJS, TypeScript, accessibility, and import ordering; configure Prettier consistently; add scripts that fail on warnings. Add optional pre-commit checks for staged formatting and linting, but keep them documented and reproducible through normal pnpm commands. Create the project coding-conventions file described in the brief and reconcile filename/component naming rules with the proposed structure.

**Verify:** deliberately malformed sample code is caught, then remove it and confirm all checks pass.

### Part 4 — Scaffold the Next.js web application

Initialize Next.js with the App Router, TypeScript, Tailwind CSS 4, and the `src/` layout. Add the root layout, metadata, global styles, error boundary, not-found page, loading shell, and route groups for authentication and dashboard pages. Install and configure Shadcn UI primitives, accessible theme tokens, icons, and toast/dialog providers. Keep Server Components as the default and isolate interactive providers into the smallest possible client boundary.

**Verify:** the web app starts, renders a basic public page and dashboard placeholder, and passes lint/type-check/build.

### Part 5 — Scaffold the NestJS API application

Create the NestJS entry point and root module, enable strict TypeScript, configure graceful shutdown, request validation, CORS, security headers, compression, request IDs, structured logging, and a consistent error envelope. Add `/health/live`, `/health/ready`, and versioned `/api/v1` routing. Install a shared rate-limiting guard (token-bucket or sliding-window) configurable via environment variables, with separate unauthenticated (strict) and authenticated (liberal) tiers as a foundation for later per-endpoint tuning. Read configuration through typed validation so startup fails with a helpful message when required variables are missing.

**Verify:** the API starts, liveness responds without dependencies, readiness describes dependency status, malformed requests receive consistent errors, and the rate-limiting guard rejects excessive unauthenticated requests while allowing authenticated traffic through.

### Part 6 — Create shared types and validators

Build the two shared packages with stable public exports. Define common identifiers, pagination, sorting, error, user, workspace, project, note, attachment, search, task, and API response contracts. Add Zod schemas for create/update/filter operations and infer TypeScript types from schemas where practical. Keep database-only and secret-bearing fields out of client contracts.

**Verify:** both applications import the packages through workspace dependencies and package-level unit tests cover valid, invalid, boundary, and coercion cases.

## Phase 2 — Local Infrastructure and Configuration

> **Development-stack update (2026-08-04):** Parts 8–10 were originally delivered with
> host-run applications and `docker/docker-compose.dev.yml`. The canonical development
> environment is now the root `compose.yaml`: one `docker compose up` runs infrastructure,
> migrations, seed initialization, shared contract watchers, API, and web. The original
> acceptance history remains in the numbered completion records; current operation is
> documented in `docs/completed-parts/all-in-docker-development-2026-08-04.md`.

### Part 8 — Define environment contracts

Create `docker/.env.example` and application-specific typed environment schemas. Separate public browser variables from server secrets, supply safe development defaults, and document how to generate strong secrets. Include database, Redis, MinIO, Meilisearch, SMTP, auth, URLs, rate limits, storage limits, AI providers, encryption keys, and feature flags. Never commit real credentials.

**Verify:** each app boots with the documented development file and fails clearly for an invalid URL, port, key length, or missing production secret.

### Part 9 — Build the development Compose stack

Create `docker/docker-compose.dev.yml` for PostgreSQL with pgvector, Redis, Meilisearch, MinIO, MinIO bucket initialization, and Mailpit. Add named volumes, internal networking, health checks, deterministic ports, and dependency conditions. Keep application processes runnable on the host for fast development while infrastructure runs in containers.

**Verify:** one command starts all services; health checks pass; PostgreSQL has the vector extension; MinIO buckets exist; Mailpit and Meilisearch respond.

### Part 10 — Add developer commands and onboarding documentation

Create the root Makefile and scripts for starting/stopping infrastructure, logs, install, build, test, migration generation/application, seed, and database studio. Ensure dangerous volume deletion is clearly named and not part of normal cleanup. Write `docs/README.md` with prerequisites, exact startup order, ports, troubleshooting, and first-login/seed credentials.

**Verify:** a developer following only the documentation can go from clone to running frontend and backend.

### Part 11 — Implement configuration and dependency clients

Create NestJS modules/config factories for PostgreSQL, Redis, MinIO, Meilisearch, SMTP, auth, and application URLs. Implement connection lifecycle, timeouts, retries, and readiness probes. Expose narrowly scoped providers instead of globally importing raw clients throughout the application.

**Verify:** dependency failures are logged without secrets, readiness becomes unhealthy, and services recover after a dependency returns.

## Phase 3 — Database Design and Tenant Safety

### Part 12 — Configure Drizzle ORM and migration tooling

Add Drizzle configuration, database provider, migration scripts, transaction helpers, and schema export conventions. Enable `uuid-ossp`/appropriate UUID support and `vector` in the initial SQL migration. Define a migration policy: generated migrations are reviewed, immutable after deployment, and tested both forward on an empty database and against seeded data.

**Verify:** migrations create and roll forward an empty local database, and the API can execute a simple health query.

### Part 13 — Implement identity and authentication tables

Create the application user schema plus all Better Auth-required tables for accounts, sessions, verification tokens, authenticators/passkeys, and two-factor data according to the installed Better Auth adapter version. Add normalized email uniqueness, timestamps, useful indexes, and deletion behavior. Avoid inventing overlapping session/JWT tables if Better Auth already owns them.

**Verify:** migration SQL matches adapter requirements and schema relation/type tests compile.

### Part 14 — Implement workspace and membership tables

Add workspaces, workspace members, invitations, role enums, branding/settings JSON, quotas, and plan fields. Enforce one membership per user/workspace, a unique workspace slug, and appropriate indexes. Decide how the last owner is protected from removal and how workspace deletion cascades.

**Verify:** database tests reject duplicate membership and invalid roles and correctly cascade a test workspace.

### Part 15 — Implement projects, notes, hierarchy, and ordering

Create project and note schemas from the brief, then add fields/tables required for note type, sibling ordering, standalone folders (maximum depth enforced in service logic), favorites/pins, sharing, and project access. Store TipTap JSON plus extracted plain text and a monotonically increasing version. Add indexes for workspace/project lists, parents, updated time, deletion state, templates, and creators. Prevent cross-workspace foreign-reference combinations in application transactions and, where feasible, composite constraints.

**Verify:** fixtures cover project notes, root notes, nested notes, templates, soft deletion, ordering, and cross-tenant rejection.

### Part 16 — Implement tags, attachments, comments, and versions

Add the tables specified for tags, note-tags, attachments, comment threads, and note versions. Add unique workspace tag names, composite primary keys for junction rows, comment selection anchors for inline comments, attachment processing status/variants, and version metadata/title if restoration should reproduce the whole note. Index common lookup and retention queries.

**Verify:** relation tests cover tag assignment, threaded comment cascade, attachment cleanup lookup, and ordered version retrieval.

### Part 17 — Implement standalone task data

Model task-list items separately from TipTap inline checklist nodes so due dates, assignees, priority, recurrence, status, ordering, and board/calendar views are queryable. Add custom task statuses/columns per workspace or project, recurrence configuration, and optional tag links. Define synchronization rules: inline checklists contribute progress but do not silently become assigned standalone tasks unless explicitly converted.

**Verify:** constraints permit ordered/nested tasks, calculate progress, and reject assignees from another workspace.

### Part 18 — Implement operations and integration tables

Create note embeddings, audit logs, API keys, webhooks, webhook deliveries, exports, AI provider configuration, AI usage, email delivery records, and any job idempotency records. Store only hashes for API keys, encrypt provider credentials with an application master key, and never store raw webhook signing secrets after initial presentation unless encrypted storage is required.

**Verify:** migration tests confirm vector dimensions/indexes, key uniqueness, delivery status constraints, and tenant-scoped indexes.

### Part 19 — Add database-level tenant protection and retention policies

Define a consistent workspace-scoping strategy for every service query. Add PostgreSQL row-level security if selected in the architecture decision, including transaction-local tenant/user context and policies; otherwise document and test the repository-layer enforcement. Define retention for deleted notes, versions, audit logs, exports, sessions, and orphaned objects.

**Verify:** automated security tests attempt cross-workspace reads and writes for every major entity and receive no data or mutation access.

### Part 20 — Create realistic seed data

Write an idempotent development seed that creates multiple users and workspaces, every role, projects, standalone/nested notes, rich TipTap content, task notes, tags, comments, versions, and attachment metadata. Include two tenants specifically for isolation tests. Use deterministic identities but never production-like secrets.

**Verify:** reseeding produces the same usable scenario without duplicates and the UI/API can browse the relationships.

## Phase 4 — Authentication, Authorization, and Application Shell

### Part 21 — Integrate Better Auth on the backend

Configure Better Auth with PostgreSQL persistence, Redis-backed session acceleration where supported, secure cookies, trusted origins, email/password, email verification, password reset, and magic links. Establish whether Better Auth manages tokens or opaque sessions; do not layer a custom JWT design on top without need. Queue outbound authentication emails rather than blocking requests.

**Verify:** registration, verification, login, logout, refresh/session lookup, magic link, forgotten password, and reset work with Mailpit.

### Part 22 — Build authentication screens and route protection

Implement accessible login, registration, forgot-password, reset-password, and verification-result pages. Use shared validation, generic credential error messages, disabled/submitting states, and safe redirect validation. Add server-side session checks to protected layouts and redirect authenticated users away from auth pages.

**Verify:** Playwright tests cover valid and invalid flows, redirects, expired links, refresh, logout, and direct access to protected routes.

### Part 23 — Add OAuth, two-factor authentication, passkeys, and session controls

Add configurable Google, GitHub, and Microsoft providers only when credentials exist. Implement TOTP enrollment/recovery codes, WebAuthn passkey registration/login, remember-me behavior, and a settings page listing and revoking active sessions. Protect high-risk changes with recent-authentication confirmation.

**Verify:** provider-disabled states are clean; TOTP, passkey, remembered/non-remembered sessions, and remote session revocation have integration coverage.

### Part 24 — Implement centralized authorization

Create guards/policies for owner, admin, editor, and viewer behavior from the permissions matrix. Add resource rules for creator-owned or explicitly shared notes, project access, comments, exports, API keys, webhooks, billing visibility, and workspace deletion. Ensure tRPC, REST, Socket.io, jobs, and file endpoints all call the same policy layer.

**Verify:** a table-driven authorization suite tests each role/action combination and cross-tenant IDs, including guessed UUIDs.

### Part 25 — Build the dashboard shell

Implement the responsive sidebar, top bar, workspace switcher, breadcrumbs, mobile navigation, user menu, command/search trigger, notification center (bell icon, unread badge, flyout list with read/unread state and mark-all-read), and nested note tree placeholders. Add keyboard focus management, skip links, responsive breakpoints, skeletons, and an application-level error state. Persist harmless UI preferences locally while tenant data remains server-derived.

**Verify:** the shell works on phone, tablet, and desktop widths and can be navigated with keyboard and screen-reader landmarks; notification read state persists across page navigation.

## Phase 5 — Core Workspace, Project, and Note Management

### Part 26 — Implement workspace lifecycle APIs

Create application services and tRPC/REST endpoints for creating, listing, reading, updating, and safely deleting workspaces. Generate collision-safe slugs, create the owner membership atomically, validate settings, and write audit events. Make destructive deletion require explicit confirmation and a background cleanup strategy for stored objects and indexes.

**Verify:** service and API tests cover validation, slug collision, owner membership transactionality, authorization, and deletion cleanup scheduling.

### Part 27 — Build workspace screens

Implement workspace list/create flows and workspace overview/settings pages. Include identity, description, logo placeholder, plan/quota visibility, page defaults, and error/empty/loading states. Keep billing controls clearly marked as nonfunctional if billing is outside the project scope.

**Verify:** a user can create, switch, rename, and view only authorized workspaces with immediate cache updates.

### Part 28 — Implement membership and invitation flows

Build invite, accept, list, role-change, resend, revoke, leave, and remove-member operations. Use expiring single-use tokens, normalize emails, prevent privilege escalation, and protect the last owner. Queue branded invitation emails and audit all administrative actions.

**Verify:** tests cover invited/unregistered users, existing users, expired/reused tokens, last-owner rules, and role boundaries.

### Part 29 — Implement project CRUD APIs

Create project services/endpoints for pagination, filters, sort, create, update, archive, complete, restore, and delete. Validate color and due dates, handle cover-image references, scope every query by workspace, and publish relevant domain events for audit/search/webhooks.

**Verify:** unit/integration tests cover statuses, authorization, pagination, and note behavior when a project is deleted or archived.

### Part 30 — Build project list and detail screens

Implement grid and compact list views first, with create/edit dialogs, cover/color presentation, status filters, due dates, members, and last activity. Build a project detail shell that hosts notes and aggregate task progress. Persist the user's selected view per workspace.

**Verify:** CRUD and filter flows are keyboard accessible, responsive, and show correct empty/error states.

### Part 31 — Implement core note APIs

Build transactional note create/read/list/update/soft-delete/restore/permanent-delete operations with optimistic concurrency using the version field. Support workspace-root and project notes, templates, document/task-list types, parent relationships, pin/favorite/archive states, filters, pagination, and plain-text extraction. Reject cyclic parenting and folder depths beyond the documented limit.

**Verify:** concurrent stale updates receive a conflict response, hierarchy cycles fail, and list filters use correct tenant-scoped indexes.

### Part 32 — Build note browsing and hierarchy UI

Create note cards, list view, recent/pinned/template/trash pages, and expandable `NoteTree`. Implement optimistic creation/renaming and drag-to-reorder/reparent with rollback on failure. Clearly separate project notes and standalone notes while preserving breadcrumbs and deep links. Build the note sharing dialog (`ShareModal`) with shareable link generation, permission selection (view/edit), and management of existing shares.

**Verify:** tree operations remain correct after refresh; keyboard alternatives exist for drag operations; shared notes enforce the selected permission for non-owner users; share revocation takes effect immediately; trash restore and permanent deletion require appropriate confirmation.

## Phase 6 — Rich Editor and Paper Experience

### Part 33 — Establish the TipTap document contract

Define the allowed TipTap schema, JSON validation/versioning, migration strategy for future extension changes, and plain-text/HTML extraction helpers. Add StarterKit and the basic formatting extensions from the brief. Sanitize links and rendered HTML and define how unsupported historical nodes are handled without data loss.

**Verify:** fixture documents round-trip through validation and rendering, unsafe URLs/HTML are rejected, and schema migration tests cover an older fixture.

### Part 34 — Build the basic editor and toolbar

Implement `TiptapEditor.tsx` and `EditorToolbar.tsx` with headings, paragraph, bold, italic, underline, strike, code, font sizes, alignment, colors, highlight, sub/superscript, links, lists, quotes, horizontal rules, code blocks, undo, and redo. Reflect active formatting, provide tooltips/ARIA labels, and make toolbar controls usable by keyboard on narrow screens. Add a keyboard shortcuts help dialog (`Cmd+/` or `?` trigger) listing all available bindings.

**Verify:** editor component tests exercise commands and keyboard shortcuts; the help dialog displays all bindings and each listed shortcut works; content is restored after remount.

### Part 35 — Add tables, checklists, markdown shortcuts, and block behavior

Configure resizable tables with row/column/cell operations, nested task lists, placeholder, gap cursor, drop cursor, and syntax-highlighted code blocks. Implement every documented markdown shortcut, including checklist and bold input rules, without interfering with ordinary text. Add Tab/Shift+Tab behavior that respects both tables and nested tasks.

**Verify:** tests cover table manipulation, nested checklist toggles, shortcut conversion, undo/redo, and pasted structured content.

### Part 36 — Build slash commands and mentions

Create a searchable slash menu with all commands from the brief, correct trigger/range handling, keyboard navigation, escape/click-away behavior, and accessible announcements. Add member mention suggestions scoped to the workspace, store stable user IDs in mention nodes, and render graceful fallbacks for removed users.

**Verify:** slash commands work at valid line positions and mention searches never disclose users from another workspace.

### Part 37 — Implement the A4/Letter page container

Create `PageContainer.tsx` with physical page dimensions, configurable margins, white paper, workspace background, shadow, A4/Letter switching, and per-note/global defaults. Implement zoom at 50/75/100/125/150 percent plus fit-width and fit-page while keeping cursor and scroll behavior stable. Separate visual pagination from stored content.

**Verify:** browser measurements match the specified sizes at 100%, switching size persists, and responsive scrolling does not clip editor controls.

### Part 38 — Add page breaks, focus mode, and print styling

Implement explicit `PageBreak` nodes and non-destructive visual overflow indicators. Add focus mode with a floating minimal toolbar and restore the prior layout when disabled. Create print CSS that removes application chrome, uses `@page` size/margins, respects explicit breaks, and avoids splitting common blocks where possible.

**Verify:** print/PDF snapshots for A4 and Letter contain only note content with predictable pagination; focus mode works via mouse and keyboard.

### Part 39 — Implement reliable save behavior

Add a debounced autosave state machine with dirty/saving/saved/error/conflict/offline states. Send version preconditions, retry transient failures safely, flush on navigation where possible, and never overwrite a newer server version silently. Distinguish document-content updates from title/settings changes and expose an explicit retry/reload/conflict-resolution UI.

**Verify:** tests simulate rapid typing, slow responses, out-of-order responses, network loss, tab close, and version conflicts without losing acknowledged content.

## Phase 7 — Images and Attachments

### Part 40 — Build secure object-storage services

Implement MinIO bucket setup, normalized object keys, presigned upload/download or streamed upload policy, content-length enforcement, MIME sniffing, filename sanitization, and authorization checks. Keep buckets private by default; exports should use expiring signed URLs rather than anonymous public access. Define object lifecycle and compensating cleanup when database/object operations partially fail.

**Verify:** integration tests cover valid objects, spoofed MIME types, oversized files, unauthorized access, expired URLs, and partial failure cleanup.

### Part 41 — Implement image ingestion and processing

Accept JPEG, PNG, GIF, WebP, SVG, and HEIC according to safe decoder support. Strip unsafe metadata, sanitize or rasterize SVGs, preserve animated GIF behavior deliberately, convert HEIC, and use Sharp to create thumbnail, medium, and full variants plus blur placeholders. Record processing state, dimensions, storage keys, and failures.

**Verify:** fixture images for every supported format produce expected variants and decompression-bomb/invalid files are rejected within resource limits.

### Part 42 — Integrate editor image insertion

Implement clipboard paste, desktop drag/drop, and multi-select file picker. Insert local preview nodes immediately, display per-file progress/error/retry/cancel, upload/process in the background, then atomically replace temporary sources with permanent attachment references. Clean up abandoned uploads and revoke local object URLs.

**Verify:** multiple concurrent uploads preserve insertion positions and the saved document never relies on temporary blob/base64 URLs.

### Part 43 — Add image manipulation UI

Create the custom image node view with aspect-ratio resize handles, Shift freeform behavior, caption, alt text, alignment, full width, wrap mode, lazy loading, and blur-up display. Clamp dimensions to the printable content area and ensure resize/alignment commands participate in editor history.

**Verify:** mouse and keyboard-accessible controls persist settings, survive reload, and render consistently in print/export.

### Part 44 — Implement generic attachment flows

Support the documented file types and configurable 50 MB limit. Add attachment upload APIs and editor cards with icon, filename, size, date, download, failure state, and confirmed deletion. Preserve the original download filename and add an authorized PDF preview using PDF.js; do not embed untrusted active documents.

**Verify:** upload/download/delete and quota errors work for each file category; access is denied after note/workspace permission loss.

### Part 45 — Add storage quotas and cleanup

Calculate workspace usage from committed objects, reserve quota during in-flight uploads, and expose usage/limit in settings. Create idempotent jobs for abandoned multipart uploads, orphaned database records/objects, expired exports, and deleted-note retention. Include a dry-run/report mode for administrative cleanup.

**Verify:** concurrent uploads cannot bypass quota, active files are never removed, and repeated cleanup runs produce the same safe result.

## Phase 8 — Tasks, Tags, Templates, and Advanced Organization

### Part 46 — Implement tags and templates

Add tag CRUD, color validation, assignment/removal, usage counts, and sidebar filtering. Implement template creation from a note and note creation from a template by copying content rather than retaining an accidental live link. Add template permissions and separate template listings.

**Verify:** duplicate tag rules, filtering, template copying, and workspace isolation have API and UI coverage.

### Part 47 — Implement standalone task CRUD and list view

Build task-note switching/creation and ordered task operations for checkbox, text, due date/time, assignee, priority, tags, recurrence, status, and bulk actions. Define timezone behavior for due dates and recurrence. Implement drag reorder with accessible alternatives and optimistic rollback.

**Verify:** list view handles grouping, overdue state, assignment rules, bulk changes, recurring completion, and concurrent reorder conflicts.

### Part 48 — Add board, calendar, and progress views

Implement Kanban columns with customizable statuses and drag transitions, then a calendar view by due date. Calculate note and project progress consistently from task data and inline checklist summaries; expose a dashboard “My Tasks” widget with overdue highlighting.

**Verify:** all views reflect the same underlying state after mutation and date rendering is correct across timezones and daylight-saving boundaries.

### Part 49 — Add project board and timeline views

Build note cards in configurable project board columns and a read-focused timeline/Gantt view based on project/note/task dates. Define behavior for records with missing dates and use pagination/virtualization for larger projects. Keep these views behind a stable view-switching contract so later enhancements do not change core note data.

**Verify:** moving an item updates its canonical status/order and timeline rendering handles overlaps and empty dates.

## Phase 9 — Search and Indexing

### Part 50 — Establish BullMQ queues and workers

Create separate high-priority/default, export, AI, and maintenance queues with typed payloads, idempotency keys, exponential retry, dead-letter handling, timeouts, and graceful worker shutdown. Configure export concurrency to two and provider-aware AI rate limits. Add Bull Board at an admin-only route with sensitive payload redaction.

**Verify:** jobs survive worker restarts, duplicates do not repeat side effects, failures retry as configured, and unauthorized users cannot access Bull Board.

### Part 51 — Build the Meilisearch indexing pipeline

Define a note index containing title, plain content, tags, workspace/project/author IDs, timestamps, and attachment flags. Configure searchable, filterable, sortable, displayed, typo-tolerance, and ranking settings. Publish idempotent index/delete jobs after successful database transactions and provide a full tenant-aware reindex command.

**Verify:** creates, edits, tag changes, moves, and deletes converge in the index; reindex repairs deliberately introduced drift.

### Part 52 — Implement full-text search APIs and UI

Add authorized search with workspace scope, project/author/date/attachment filters, relevance/date sorting, highlights, pagination, suggestions, and recent searches. Build the global Cmd/Ctrl+K experience plus full result and filter panels. Sanitize highlighted markup and fetch authoritative metadata/permissions before returning results.

**Verify:** typo tolerance and filters work, deleted/unauthorized notes never appear, shortcut focus is reliable, and empty/error/loading states are accessible.

### Part 53 — Add embeddings and semantic search

Create provider-neutral embedding interfaces, chunk or truncate long notes predictably, and enqueue generation after changes. Store model/dimension/content-hash metadata so stale vectors can be identified and reindexed. Implement tenant-scoped cosine search and skip it cleanly when no embedding provider is configured.

**Verify:** changed content invalidates old vectors, dimension mismatches are detected before query execution, and tenant isolation applies inside the vector query.

### Part 54 — Implement hybrid ranking

Combine normalized Meilisearch relevance and vector similarity with a documented weighting and deterministic tie-breaker. Allow text-only fallback, measure latency, and expose enough internal diagnostics to tune ranking without leaking scores unnecessarily to users.

**Verify:** a curated relevance fixture demonstrates exact-term, typo, and conceptual matches in an expected order; fallback behavior works during provider outages.

## Phase 10 — Versioning, Comments, and Real-Time Collaboration

### Part 55 — Implement version snapshot and retention logic

Create a version snapshot transaction before each accepted non-collaborative update and define checkpoint frequency for high-frequency collaborative changes to prevent a version per keystroke. Store author, timestamp, version, and recoverable content. Add plan-aware retention jobs: 30 days for free and unlimited for eligible plans.

**Verify:** snapshots are ordered and immutable, retention keeps protected/current checkpoints, and a failed update does not create a misleading version.

### Part 56 — Build version history, diff, and restore UI

Add the version sidebar, read-only preview, author/time labels, semantic JSON-to-text/block diff, and side-by-side additions/deletions. Restore by creating a new current version rather than deleting history, and require edit permission.

**Verify:** restore round-trips complex content including tables/images and immediately appears in history, search, and collaborators' views.

### Part 57 — Build authenticated Socket.io infrastructure

Create an authenticated gateway, workspace/note rooms, connection rate limits, origin checks, presence heartbeat, disconnect cleanup, and Redis adapter for multi-instance pub/sub. Re-run authorization on room join and on permission-sensitive operations, not only at initial connection.

**Verify:** two API instances share room events; expired/revoked sessions disconnect; users cannot enumerate or join unauthorized rooms.

### Part 58 — Integrate Yjs collaborative editing

Bind TipTap to Yjs, implement server persistence/checkpointing, awareness/cursor state, user colors, and document loading. Define which path owns writes so autosave and CRDT updates cannot race as competing sources of truth. Add reconnect and offline-update synchronization, size limits, and recovery for corrupted/missing collaborative state.

**Verify:** multiple browsers edit the same regions concurrently, go offline/reconnect, and converge to identical content without lost edits.

### Part 59 — Add presence and collaboration UI

Display current viewers, colored selections/cursors with names, typing state where useful, connection status, and reconnect feedback. Ensure anonymous color assignment is stable per session and presence data is ephemeral rather than stored as audit history.

**Verify:** join/leave/crash/timeout cases remove stale presence and UI remains usable with many viewers.

### Part 60 — Implement inline comments and mentions

Store text-selection anchors robustly enough to remap through collaborative edits, support threads/replies, resolve/unresolve, and orphaned-anchor display. Broadcast comment events in real time and enqueue deduplicated mention notifications. Persist notifications with read/unread state, type, actor, target reference, and timestamp; expose a list endpoint for the notification center. Apply viewer-comment permissions and prevent users from forging mention recipients outside the workspace.

**Verify:** anchors survive nearby edits, replies sync across clients, resolution is audited, each mention generates at most one notification, and the notification center displays accurate read/unread state and history.

## Phase 11 — Export, Email, API Keys, and Webhooks

### Part 61 — Build the email subsystem

Configure Nodemailer and React Email templates for welcome, verification, magic link, reset, invitation, mention, export-ready, and optional digest emails. Send every email through BullMQ with idempotency, retries, delivery records, safe logging, unsubscribe controls where applicable, and workspace branding.

**Verify:** Mailpit snapshots render correctly on desktop/mobile and retries never create duplicate transactional emails for one event.

### Part 62 — Implement export job lifecycle

Create export request, status, authorization, expiry, cancellation, and download endpoints. Store selected format/options and queue the job; use deterministic state transitions from queued through processing, ready, failed, expired. Upload results privately and issue short-lived signed download links, then notify the requester.

**Verify:** UI polling/status updates work, failed jobs show safe errors, and expired or unauthorized downloads fail.

### Part 63 — Implement PDF and HTML export

Render sanitized note content through a dedicated export template, load assets through authorized server access, and use Puppeteer with controlled network/file access. Match A4/Letter settings, margins, page breaks, page numbers, and optional headers/footers. Generate standalone HTML with embedded safe styles and referenced or packaged assets.

**Verify:** visual regression fixtures match editor print output and untrusted content cannot make Puppeteer access internal services.

### Part 64 — Implement Markdown, TXT, DOCX, and ZIP export

Create explicit conversions for all supported TipTap nodes, with documented fallbacks for content a format cannot represent. Generate plain text, Markdown, and DOCX; optionally package attachments, comments, and version history in a ZIP using safe filenames and bounded resource consumption.

**Verify:** fixture exports open in target applications and include/exclude options produce exactly the requested artifacts.

### Part 65 — Implement public REST API and API key management

Expose versioned CRUD endpoints using the same services/policies as tRPC. Add pagination/filter/sort contracts, OpenAPI documentation, hashed scoped API keys whose full value is shown once, revocation/expiry/last-used tracking, and rate limits from the brief with three tiers: unauthenticated (strict, per-IP), authenticated user (generous, for abuse prevention — 1000/min default, configurable per deployment), and API key (moderate, per-key — 100/min default). Apply the shared guard from Part 5 and tune per-endpoint where needed.

**Verify:** contract tests compare REST behavior to application-service behavior; read keys cannot write, revoked keys stop immediately, raw keys never appear in logs/database, and each rate-limit tier independently blocks at its configured threshold without affecting other tiers.

### Part 66 — Implement webhooks and delivery logs

Add webhook configuration and events for note/project/member changes. Sign timestamped canonical payloads with HMAC-SHA256, prevent self-targeting/internal-network SSRF, retry five times with exponential backoff, and record redacted request/response metadata. Provide admin delivery history and manual retry.

**Verify:** signature fixtures are reproducible, receiver timeouts do not block application writes, retries are idempotent, and private/local IP destinations are rejected.

## Phase 12 — AI Capabilities

### Part 67 — Build provider-neutral AI configuration and governance

Define interfaces for chat/streaming and embeddings with OpenAI and Anthropic adapters where applicable. Allow workspace admins to select a provider or disable AI, store credentials encrypted, redact prompts/keys from logs, track token/cost usage, enforce quotas/rate limits, and define explicit data-retention consent messaging.

**Verify:** disabled/missing-key states are harmless, credential rotation works, tenant usage is isolated, and provider errors map to actionable UI messages.

### Part 68 — Implement summarize, continue writing, and tone rewrite

Create authorized endpoints/jobs with bounded context, prompt versioning, cancellation, streaming, and output validation. Build the editor/sidebar UX for summary lengths, continuation via Cmd/Ctrl+Enter, regenerate/accept/dismiss, and selected-text tone transformations. Never mutate a note until the user accepts generated content.

**Verify:** streaming can be cancelled, selection changes do not replace the wrong text, quotas are charged once, and malicious note instructions cannot access tools or other tenant data.

### Part 69 — Implement meeting extraction and auto-tagging

Validate structured AI output for attendees, agenda, discussion points, decisions, and action items; show a review screen before inserting content or tasks. Suggest only authorized existing tags plus clearly separated new-tag proposals, and require confirmation before assignment.

**Verify:** malformed model output is repaired/rejected safely, duplicate tasks/tags are prevented, and no content is changed without confirmation.

### Part 70 — Implement grammar and style assistance

Send bounded text segments with stable position identifiers, display non-destructive decorations, and remap or invalidate suggestions when text changes. Support per-user enablement, accept/dismiss, batch checking, debouncing, and privacy disclosure.

**Verify:** stale suggestions cannot edit new text, collaborative changes are handled, and disabling the feature stops outbound requests.

## Phase 13 — Enterprise Controls and Customization

### Part 71 — Add audit logging and administrative views

Create a centralized append-only audit service for auth, workspace, member, project, note, export, API-key, webhook, branding, and administrative queue actions. Capture actor, workspace, action, entity, request ID, IP, user agent, and safe metadata. Build permissioned filters/export while excluding secrets and document content unless explicitly required.

**Verify:** sensitive mutations produce exactly one immutable event and viewers/editors cannot access administrative logs.

### Part 72 — Implement branding and customization

Add logo upload, accent-color validation, application/email branding, and safe fallback behavior. If custom CSS is implemented for enterprise workspaces, sanitize/contain it to prevent data exfiltration, UI spoofing, or admin lockout; otherwise ship it disabled and document the security prerequisite.

**Verify:** branding is tenant-scoped, accessible color contrast is warned/enforced, and broken assets fall back to Notted branding.

### Part 73 — Implement custom-domain support

Add domain ownership verification, normalized uniqueness, pending/verified/error states, host-to-workspace resolution, trusted-host enforcement, and secure cookie strategy. Integrate reverse-proxy/ACME automation only after verification, and document DNS CNAME and renewal behavior.

**Verify:** unverified domains cannot route tenants, host-header spoofing fails, certificates renew in staging tests, and auth works on configured domains.

### Part 74 — Harden security and abuse controls

Review CSRF, XSS, SSRF, SQL injection, path traversal, upload bombs, websocket abuse, brute force, session fixation, open redirects, CSP, CORS, and secret handling. Add tighter rate limits on authentication endpoints (login, register, password reset, magic link) beyond standard tiers, account lockout/backoff, dependency/container scanning, signed URLs, secure headers, and log redaction. Produce a threat model and remediation checklist.

**Verify:** automated security tests and a manual OWASP-oriented review find no unresolved critical/high issue; exceptions have owners and deadlines.

## Phase 14 — Testing, Performance, Accessibility, and Observability

### Part 75 — Complete the automated test pyramid

Maintain Vitest unit tests for utilities/services/components, NestJS integration tests with real infrastructure for persistence boundaries, API contract tests, and Playwright end-to-end journeys. Cover registration, workspace invitation, project/note editing, upload, task management, search, collaboration, export, and role denial. Enforce at least the specified 70% coverage while prioritizing critical-path branch coverage over superficial percentages.

**Verify:** the full suite passes repeatedly from a clean database and failed tests retain useful traces/screenshots without secrets.

### Part 76 — Perform accessibility and browser validation

Audit WCAG 2.2 AA concerns: semantic structure, keyboard operation, focus order, dialogs, menus, editor toolbar, drag alternatives, contrast, reduced motion, zoom, announcements, and error association. Test current Chrome, Firefox, Safari/WebKit, and Edge behavior, with special attention to contenteditable, clipboard, print, and WebAuthn differences.

**Verify:** automated axe scans plus manual keyboard/screen-reader checks have no unresolved serious issues on core journeys.

### Part 77 — Test performance and scale limits

Define budgets for first load, interaction latency, API p95, editor input, websocket propagation, search, and job wait time. Test large documents, deep note trees, thousands of search results, many tasks, concurrent editors, bulk uploads, and export pressure. Add pagination/virtualization, indexes, caching, backpressure, and payload limits based on measurements.

**Verify:** benchmark results meet recorded budgets on target VPS-class hardware and degradation is controlled beyond expected capacity.

### Part 78 — Add observability and operational diagnostics

Implement structured correlated logs, metrics for HTTP/jobs/websockets/dependencies, error reporting, health/readiness, and dashboards/alerts using self-hostable/open-source-compatible tooling. Track queue depth/failure, database pool saturation, Redis/Meilisearch/MinIO health, AI usage, export duration, and storage growth. Define log retention and exclude content, tokens, keys, and passwords.

**Verify:** inject representative failures and confirm alerts and diagnostic context identify the affected tenant/request without revealing secrets.

## Phase 15 — Production Packaging and Operations

> **Note (2026-08-04):** development now runs entirely in Docker from the root
> `compose.yaml` (see `docs/completed-parts/all-in-docker-development-2026-08-04.md`).
> Parts 79 and 80 should build on that file's service graph, networks, and health gating
> rather than starting over — the production stack differs by using built images instead of
> a bind-mounted workspace, and by adding resource limits, restart policy, and the proxy.
> `docker/Dockerfile.dev` is development-only and is not a base for the production images.

### Part 79 — Create production Docker images

Write multi-stage, reproducible Dockerfiles for web, API, and dedicated worker processes. Use locked dependencies, minimal runtime contents, non-root users, read-only filesystems where feasible, health checks, init/signal handling, and pinned base-image versions. Ensure Puppeteer and Sharp runtime dependencies are present without bloating unrelated containers.

**Verify:** images build from a clean checkout, start without root, handle SIGTERM gracefully, and pass vulnerability/size review.

### Part 80 — Build the production Compose stack

Create production Compose configuration for PostgreSQL/pgvector, Redis, Meilisearch, MinIO initialization, API, web, and separate workers, with persistent volumes, health-gated dependencies, resource limits, restart policy, private networking, and loopback-only published application ports behind the proxy. Remove anonymous export buckets and avoid exposing infrastructure ports publicly.

**Verify:** the complete stack starts on a clean host, becomes healthy in dependency order, survives service restarts, and retains data across redeployment.

### Part 81 — Implement safe migrations and deployment scripts

Create setup, migrate, and deploy scripts that validate configuration, back up before risky migrations, build/pull images, apply backward-compatible migrations once, roll services with health verification, and retain a rollback path. Do not routinely destroy the running stack before the replacement is ready. Document zero/low-downtime constraints and irreversible migration handling.

**Verify:** rehearse initial deployment, routine update, failed health check rollback, and schema migration against staging data.

### Part 82 — Configure reverse proxy, TLS, and network policy

Provide hardened Nginx or Traefik configuration for web, API, WebSocket upgrades, request/upload sizes, timeouts, security headers, HTTP-to-HTTPS redirect, trusted forwarding headers, and Let's Encrypt renewal. Keep PostgreSQL, Redis, Meilisearch, MinIO, and Bull Board inaccessible from the public network.

**Verify:** TLS configuration passes a reputable scanner, WebSockets remain stable, large allowed uploads work, oversized requests fail cleanly, and internal ports are unreachable externally.

### Part 83 — Implement backup, restore, and disaster recovery

Back up PostgreSQL consistently and MinIO objects with matching recovery points; encrypt backups, copy them off-host, enforce retention, and monitor success. Include configuration/secret recovery procedures without embedding secrets in scripts. Write a restore script/runbook that restores into a new environment and verifies migrations, object references, users, search rebuild, and queues.

**Verify:** perform a timed restore drill from backup, compare record/object counts and sample hashes, reindex search, and record RPO/RTO achieved.

### Part 84 — Write complete technical documentation

Finish `docs/ARCHITECTURE.md`, `docs/API.md`, and `docs/DEPLOYMENT.md`. Add diagrams/data flows where useful, module boundaries, tenancy and permission rules, local setup, environment reference, migrations, queues, storage, search reindex, AI configuration, domain/TLS setup, backup/restore, incident response, and troubleshooting. Generate/link OpenAPI documentation and record known limitations.

**Verify:** a fresh developer setup and a staging deployment are completed by following documentation alone; discrepancies are fixed in docs or automation.

## Phase 16 — Release Preparation and Incremental Delivery

### Part 85 — Define and validate the MVP release slice

Treat authentication, workspace membership/RBAC, project and standalone note CRUD, the paper editor, autosave, basic images/attachments, tags/templates, full-text search, version restore, email, audit logging, and production backup as the MVP. Keep semantic search, live CRDT editing, advanced task views, AI, public API/webhooks, white-label domains, and some export formats behind feature flags until their phases pass acceptance tests.

**Verify:** every MVP journey works on staging with production-like configuration and optional systems disabled do not break core behavior.

### Part 86 — Run staging acceptance and release rehearsal

Seed staging with representative multi-tenant data, run the full automated suite, execute manual acceptance scripts, load/security/accessibility tests, migration rehearsal, backup/restore, email delivery, uploads, print/export, and browser checks. Test upgrade from the previous staged build, not only a fresh install. Triage all findings by severity and block release on critical/high correctness or security issues.

**Verify:** a signed release checklist links test evidence, known limitations, rollback steps, and operations ownership.

### Part 87 — Release the MVP and monitor it

Tag immutable versions, deploy using the rehearsed process, run smoke tests, confirm health/metrics/queues/storage/search, and watch error and latency signals through an agreed observation window. Keep rollback artifacts ready and communicate status without exposing internals. Confirm backups after the first production write cycle.

**Complete when:** core journeys succeed in production, monitoring is quiet or understood, backup verification passes, and release notes/documentation match the deployed version.

### Part 88 — Deliver post-MVP capabilities in controlled increments

Enable one advanced area at a time in this order: standalone task board/calendar and project timeline; semantic/hybrid search; real-time collaboration/comments; additional exports; public API/webhooks; AI tools; white-label/custom domains. For each increment, repeat focused threat modeling, migration rehearsal, tenant-isolation tests, performance tests, documentation, staged rollout, and monitoring. Use per-workspace feature flags for risky capabilities and retain a kill switch for external providers.

**Complete when:** every feature in `Notted.md` is enabled only after its own acceptance criteria pass, with no regression to the stable core product.

## Milestone Checkpoints

1. **Foundation ready (Parts 1–11):** monorepo, applications, typed configuration, and local infrastructure are reproducible.
2. **Secure data layer ready (Parts 12–20):** complete schema, migrations, tenant enforcement, and seed data exist.
3. **Usable account shell (Parts 21–25):** users can authenticate and enter an authorized workspace shell.
4. **Core organization ready (Parts 26–32):** workspaces, members, projects, and note hierarchy work end to end.
5. **Editor MVP ready (Parts 33–45):** paper editor, autosave, rich content, images, and attachments are reliable.
6. **Organization and search ready (Parts 46–54):** tasks, tags, templates, indexing, and hybrid search work.
7. **Collaboration ready (Parts 55–60):** history, comments, presence, and conflict-free editing are dependable.
8. **Platform integrations ready (Parts 61–74):** exports, email, API/webhooks, AI, branding, domains, audit, and security are complete.
9. **Production ready (Parts 75–84):** quality, performance, observability, containers, deployment, and recovery are proven.
10. **Released incrementally (Parts 85–88):** MVP is stable and advanced features are enabled through controlled rollouts.

## Recommended Tracking for Every Part

For each part, create a small issue or pull request containing: scope, dependencies, database/API/UI changes, security and tenancy considerations, tests, documentation updates, rollout or migration notes, and the stated verification criteria. When the part passes its completion criteria, add its summary under `docs/completed-parts/` and link that record from the issue or pull request when possible. Avoid combining unrelated parts merely because they touch the same directory; small reversible changes will make this large system easier to review and operate.
