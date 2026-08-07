# Completed Parts

This directory is the durable implementation history for the numbered parts in the root [`Plan.md`](../../Plan.md). Its purpose is to let another developer, agent, or later session understand what has actually been built without reconstructing decisions from source code or conversation history.

## Required Workflow

1. Before starting a plan part, read the completion records for all prerequisite parts and inspect any open risks they identify.
2. Implement and verify the selected `Plan.md` part according to its stated requirements and completion criteria.
3. Copy `TEMPLATE.md` to `part-NN-short-name.md`, where `NN` is the zero-padded part number.
4. Replace every placeholder with factual information. Do not claim tests or commands that were not run.
5. If verification was skipped or failed, mark it clearly and do not describe the part as complete.
6. Add later corrections or discoveries to the existing record instead of creating a competing summary.

## Naming and Scope

- Use one primary record per numbered part: `part-01-architecture-decisions.md`, `part-02-monorepo-initialization.md`, and so on through `part-88-post-mvp-delivery.md`.
- Keep the record focused on the implemented part. Link related records rather than copying their content.
- Use repository-relative paths and include migration names, configuration keys, API routes, and important symbols where they help future work.
- Never include passwords, tokens, private keys, connection strings with credentials, personal data, or other secrets.
- A record may be prepared while work is ongoing, but its status must remain `In progress` until every required completion criterion passes.

## Status Values

- `Complete`: all stated completion criteria passed.
- `Complete with follow-up`: the part is usable and verified, but explicitly listed non-blocking work remains.
- `In progress`: implementation or required verification remains.
- `Blocked`: work cannot continue; the blocker and required resolution are recorded.
- `Superseded`: a later decision or implementation replaced this work; link the replacement record.

## Index

Add one row after creating each record. Keep rows ordered by part number.

| Part | Status   | Completed  | Summary                                                                                                                                                                 |
| ---: | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | Complete | 2026-07-22 | Architecture boundaries, safe schema defaults, and a strictly resolved compatibility baseline.                                                                          |
|    2 | Complete | 2026-07-22 | pnpm + Turborepo monorepo scaffolding, four canonical workspaces, root task scripts, and strict runtime/package pins.                                                   |
|    3 | Complete | 2026-07-23 | App-scoped Next.js/NestJS + repo-wide TypeScript/a11y/import ESLint, Prettier, fail-on-warning scripts, and optional commit gates.                                      |
|    4 | Complete | 2026-07-27 | Next.js 16 App Router scaffold with canonical styles, minimal client islands, accessibility coverage, production build, and rendered HTTP smoke.                        |
|    5 | Complete | 2026-07-27 | NestJS API scaffold with typed configuration, safe HTTP bootstrap, health endpoints, structured logging, error envelopes, bounded rate limiting, and graceful shutdown. |
|    6 | Complete | 2026-07-24 | Verified framework-neutral shared types and strict Zod validators consumed through API and web package boundaries.                                                      |
|    7 | Complete | 2026-07-27 | Least-privilege SHA-pinned CI, safe coverage artifacts, deterministic builds, real Drizzle consistency, and verified green/failure/reverted-green behavior.             |
|    8 | Complete | 2026-07-27 | Typed API/web/infrastructure environment contracts, safe examples, strict production preflight, dotenv-aware cross-file checks, and contract tests.                     |
|    9 | Complete | 2026-07-27 | Digest/source-pinned healthy development services, internal networking with host loopback access, non-root MinIO, private buckets, volumes, and runtime recovery proof. |
|   10 | Complete | 2026-07-27 | Canonical developer commands, local-daemon guarded reset, legacy-volume recovery guidance, and stepwise onboarding verification.                                        |
|   11 | Complete | 2026-07-27 | Narrow PostgreSQL, Redis, MinIO, Meilisearch, and SMTP clients with bounded lifecycle, coalesced readiness, and live loss/recovery proof.                               |
|   12 | Complete | 2026-07-27 | Drizzle/PostgreSQL providers, transaction helper, immutable extension migration, schema conventions, policy, and empty/pre-existing-data verification.                  |
|   13 | Complete | 2026-07-29 | Better Auth 1.6.24 identity schema with existing users model, database-generated UUID contract, boolean verification plus preserved timestamp, and auth-owned tables.   |
|   14 | Complete | 2026-07-29 | Workspace roots, memberships, invitations, roles, plans, quotas, uniqueness, and tenant-lifecycle foreign keys.                                                         |
|   15 | Complete | 2026-07-29 | Projects, folders, hierarchical notes, ordering, sharing/access grants, and composite cross-workspace foreign keys.                                                     |
|   16 | Complete | 2026-07-29 | Tags, attachment metadata, threaded comments, and uniquely keyed note-version snapshots.                                                                                |
|   17 | Complete | 2026-07-29 | Standalone tasks, custom statuses, nesting, recurrence, assignees, ordering, and task-tag links.                                                                        |
|   18 | Complete | 2026-07-29 | Operations/integration schema including durable job outbox intent and independent worker idempotency.                                                                   |
|   19 | Complete | 2026-07-29 | Repository-layer tenant context, strict pre-SQL guards, all-operation isolation matrices, and retention policy.                                                         |
|   20 | Complete | 2026-07-29 | Deterministic multi-tenant seed fixtures with idempotent writes and production/target-name safety refusal.                                                              |
|   21 | Complete | 2026-07-31 | Better Auth backend, opaque sessions, Redis acceleration, and encrypted durable auth-email delivery verified with live infrastructure. |
|   22 | Complete | 2026-07-31 | Accessible auth screens, safe redirects, server route protection, logout, and critical Chromium journeys verified. |
|   23 | Complete | 2026-07-31 | Optional OAuth, TOTP/recovery, passkeys, remember-me, recent authentication, and safe session controls verified. |
|   24 | Complete | 2026-07-31 | Central authorization policy, tenant-scoped facts, shared adapters, and cross-tenant denial verified. |
|   25 | Complete | 2026-07-31 | Responsive shell, server-validated workspace selection, persistent notifications, migration, accessibility, and browser journeys verified. |
|   26 | Complete | 2026-08-01 | Verified REST/tRPC workspace lifecycle with replay-safe creation, atomic owner membership, tenant authorization, durable deletion audit, and cleanup intent. |
|   27 | Complete | 2026-08-01 | Accessible workspace list/create, overview, settings, switching, permission states, and real-stack Chromium lifecycle/isolation journeys. |
|   28 | Complete | 2026-08-01 | Verified membership and single-use invitation lifecycle with role/last-owner safety, durable queued email delivery, acceptance UI, and audit evidence. |
|   29 | Complete | 2026-08-01 | Tenant-scoped project CRUD, filtering, lifecycle transitions, cover authorization, replay safety, durable domain events, and note/task preservation. |
|   30 | Complete | 2026-08-02 | Project list/detail UI, read projection, durable restriction state; Review #2: a11y, type-check, lint, integration all pass. |
|   31 | Complete | 2026-08-02 | Transactional note/folder APIs, deletion batches, safe cascade, versioned renormalization, index/concurrency artifacts; Review #2: calculatePosition fix, planner assertions, all gates pass. |
|   32 | Complete | 2026-08-02 | Note hierarchy/sharing UI, DnD, folders/trash, authenticated sharing, rollback injection; Review #2: a11y, clipboard race, keyboard DnD, focus mgmt, all gates pass. |
|   33 | Complete | 2026-08-03 | Versioned TipTap allow-list, bounded migration, safe URL/plain/HTML helpers, exact headless extensions, and verified ProseMirror round-trips. |
|   34 | Complete | 2026-08-03 | TipTap editor and roving-tabindex toolbar, drift-proof shortcut table and help dialog, sanitized link/colour dialogs, remount restoration; Review #2: ARIA and duplicate-render fixes, all gates pass. |
|   35 | Complete | 2026-08-03 | Table contract widening with bounds, resizable tables, restored nested checklists, lowlight code blocks, markdown rules, single Tab authority; Review #2: Table keymap strip fix, split-cell guard, all gates pass. |
|   36 | Complete | 2026-08-03 | Mention node contract, slash command menu, workspace-scoped mentions with removed-user fallback, shared suggestion popover; Review #2: member pagination and lazy directory fetch, all gates pass. |
|   37 | Complete | 2026-08-06 | A4/US Letter paper in physical CSS units, configurable margins, seven zoom settings with scaled scroll extents, server-persisted per-note page size. Measured in Chromium: 794x1123 and 816x1056 at 100%, size survives reload, controls unclipped at 390/768/1440. |
|   38 | Complete | 2026-08-06 | Additive `pageBreak` contract node, TipTap atom, `/page-break` command, two shortcuts, non-destructive overflow guides, focus mode, standalone `print.css` with a generated `@page` rule. A4/Letter PDF snapshots taken in Chromium — correct MediaBox, two pages from the explicit break, no chrome in print; browser pass also caught and fixed a break-deleted-by-typing defect. |
|   39 | Complete with follow-up | 2026-08-06 | Pure autosave state machine — one version cell, one in-flight request, coalesced content+settings PATCH, out-of-order discard, bounded backoff, halting conflict, in-memory offline queue, keepalive navigation flush, explicit retry/reload UI. All six named verify scenarios covered without a browser; Review #2 raised no blocking finding. |
|   40 | Complete | 2026-08-07 | Private-bucket image upload/download: `ObjectStorageService` byte plane, opaque `w/{ws}/a/{id}/{variant}/{token}{ext}` keys, busboy limits enforced before and during transfer, first-party magic-byte sniffing (AVIF rejected), filename sanitization, derived `FOR UPDATE` quota, pending/processing/ready/failed lifecycle with after-commit compensating cleanup, and proxied streaming with the mandatory `Cross-Origin-Resource-Policy: same-site` override. All gates executed and passing; live PostgreSQL + MinIO suites pass; **CORP confirmed in Chromium**, closing the phase's highest-risk item. Fixed the 304 `Content-Length` and mapped disabled storage to a clean 503; orphan sweep recorded as delegated to Part 45. Also made the API coverage gate runnable for the first time (writable container volumes for `coverage`/`test-results`, image-side `mkdir` for correct volume ownership, vitest `clean: false` + `reportOnFailure`) — in-container global 81.81/74.81/85.19/83.61 — and fixed a pre-existing `app.e2e.test.ts` failure that inherited the container's `BETTER_AUTH_TRUSTED_ORIGINS`. |
|   41 | Complete with follow-up | 2026-08-07 | Sharp-backed image pipeline filling Part 40's `IMAGE_PROCESSOR` seam: admission → header-only `.metadata()` → pixel/frame budget → pixels, so a decompression bomb dies before a decoder runs; `original` kept verbatim, `full` a metadata-stripped source-family re-encode bounded to 2000 px, `medium`/`thumbnail` WebP, and a 2 KiB inline WebP blur data URI that structurally cannot enter the document. Animation preserved in `full` only, SVG rasterized rather than sanitized (no servable `image/svg+xml`), HEIC converted behind a one-file seam with a byte cap and timeout, seven fully defaulted resource budgets, three new stable failure codes. `sharp 0.35.0` reconciled against `Notted.md`'s `0.33.x` in ADR 0008; All gates executed and passing (`src/attachments` coverage 94/87/95/96). Fixed a `sharp` `GifOptions` defect (`reoptimise` is not a key; `reuse: false` is the real option) that had failed `build` and left the API container restarting, corrected the EXIF fixture so the GPS-stripping assertion is no longer vacuous (libvips' GPS IFD is `IFD3`), and widened the SVG gates to namespace-prefixed elements. **Follow-up: `libheif-js` LGPL-3.0 still awaits human sign-off.** |
|   42 | Complete | 2026-08-07 | Browser half of image support: contract widened additively with a block `image` node whose four attributes contain **no `src`** — the absence is what makes "the saved document never relies on temporary blob/base64 URLs" structurally true, and a dedicated test proves every URL-shaped attribute is rejected. Temp upload state lives in ProseMirror **decorations**, never a pending node, so `getJSON()` is byte-identical and Part 39 autosave can never PATCH a dangling attachment reference. Hand-written `CustomImage.ts` (`@tiptap/extension-image` rejected: its data model is a `src`), XHR-over-fetch for upload progress with one idempotency key per file across retries, concurrency 3, blur-up node view with no layout shift, `/image` command and toolbar button that insert nothing until bytes have a permanent id. Schema version stays 1 with the bump trigger recorded. Four exact-set guardrail tests updated with intent, including hardening the editor's "no network I/O" rule to cover `XMLHttpRequest`. **Two real-browser defects found and fixed in the final pass.** A multi-file batch landed only one image: TipTap's `insertContentAt` widens a block insertion to swallow the enclosing paragraph, so the first completion's step spanned the position its siblings were anchored at and `DecorationSet.map` reported them deleted — broken for empty paragraphs, for a caret at the end of any paragraph, and for a whole-document replacement, while the one caret position every existing test used happened to survive. Fixed by re-anchoring deleted placeholders with `map(pos, 1)`, with a deliberate exception for whole-document replacement so an upload begun in one note cannot land in another. Separately, the decoration's `destroy` hook fired on every document change rather than on teardown, so one keystroke revoked every in-flight preview; revocation now belongs solely to the upload manager. All gates pass (web 1016; coverage 82.73/75.51/85.20/84.93); `note-images.spec.ts` passes 3/3 in Chromium including CORP `naturalWidth` and the 125% drop. **Carried forward: Part 43 must ship the alt-text editor.** |

## Cross-cutting records

Work that is not a numbered `Plan.md` part. Keep rows ordered by date.

| Record | Status | Completed | Summary |
| --- | -------- | ---------- | ------- |
| [Coverage remediation](coverage-remediation-2026-08-04.md) | Complete | 2026-08-04 | Made `pnpm test:ci` pass in all four workspaces: CI Postgres service plus the `turbo.json` env declaration that makes it effective, serialized DB suites, fixed a leaking concurrency fixture, fixed the archived-notes list query, and covered `src/lib`, the auth service/controller, and the shared route builders. |
| [All-in-Docker development](all-in-docker-development-2026-08-04.md) | Complete | 2026-08-04 | Replaced the infrastructure-only Compose stack with a root `compose.yaml` that runs infrastructure and both applications, so `docker compose up` is the only setup command, and cut the published port surface from nine to three (3000, 3001, 8025). Verified from a clean state, including registration through Mailpit email verification to an authenticated session. |
| [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md) | Complete | 2026-08-07 | Gave Playwright its own `e2e` Compose profile — separate database, MinIO buckets and Redis logical database — because the suite had been running against `notted_dev` and failing on its own accumulated rows. Removing that noise exposed a real 500 on `GET /workspaces/:id/projects/:id`: drizzle returns timestamps as raw strings and a bare `sql<Date>` aggregate carries no decoder, so a false type predicate let a string reach `.getTime()`. Fixed with a typed `maxTimestamp` helper, an audit of all 8 `sql<...>` sites, and a regression test that exercises real driver marshalling. Suite now 19 passed / 0 failed. |
