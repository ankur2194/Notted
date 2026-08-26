# Part 77 — Test performance and scale limits

## Status

- **State:** Complete — on the hardware this session has; the VPS-class clause is the standing residual
- **Completed on:** 2026-08-26
- **Implemented by:** Backend/platform agent, session `3fb3cda0`
- **Plan reference:** `Plan.md`, Part 77
- **Related records:** [Part 75](part-75-automated-test-pyramid.md), [Part 76](part-76-accessibility-browser-validation.md), [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md)

**Completeness statement.** The implementing agent ran no benchmark, which is why this record spent two
sessions at *In progress*. It has now been run: the harness executed against a live `e2e` stack and the
measured table is below, filled in rather than promised.

Read Part 77's Verify clause exactly as written — *"benchmark results meet recorded budgets **on target
VPS-class hardware** and degradation is controlled beyond expected capacity."* **The hardware is part of
the clause.** No such machine exists in this project before Phase 15, so the clause cannot be discharged
here for any budget, and a green table measured on this host would not have discharged it either. What
this session could do, and did:

- every budget defined, each with a written justification, and **none edited to match a result**;
- the harness executed end to end, with two defects in it found and fixed on first run;
- **eight scenarios measured**, and as of 2026-08-26 **all eight PASS** — `job.export.wait`, the one
  earlier miss, was instrumented rather than optimized and turned out to be measuring outbox pickup
  latency, not export work (p95 2,591 ms against 30,000 ms; the export job itself is 126 ms at p50);
- one scenario `SKIPPED` by choice and four `NOT MEASURED`, each with a named blocker and never a number;
- the earlier miss **closed by instrumentation rather than optimization**, with its "Puppeteer cold
  start" diagnosis **retracted** because the code contradicts it — and replaced by a named residual that
  is a queue-design decision, not a performance one: unconsumed `job_outbox` intents saturate the
  dispatcher past roughly 3,000 rows.

So: complete on this session's scope, with the VPS-class certification carried as the explicit
residual. Every number below is a **floor** for regression detection, not a
certification — see the host honesty statement.

## Objective

Record explicit performance budgets, build a harness that can measure them against realistic scale, and
add pagination, virtualization, indexes, caching, backpressure, and payload limits **where a measurement
shows they are needed**. Later parts (Phase 15 packaging, Part 78 observability) inherit both the budget
file and the standing rule that an optimization needs a failing measurement first.

## Implemented Work

- **`scripts/perf-budgets.json`** is the single source of every performance number. Twelve scenarios, each
  with a `p95Ms` (or `null`) and a `why` that justifies the value. Prose never restates a number.
- **`scripts/perf-bench.mjs`** is a plain Node 22 ESM harness — global `fetch`, `node:crypto`,
  `performance.now()`, **zero new dependencies**. Two subcommands:
  - `seed` registers an account, polls Mailpit for the verification link, verifies, signs in, keeps the
    session cookie, creates a workspace, and generates the scale fixture through the real HTTP API.
  - `run` samples each scenario and prints a markdown table with `PASS` / `FAIL` / `VOID` /
    `NOT MEASURED` / `SKIPPED` per scenario. It writes no results file.
- **`scripts/perf-bench.test.mjs`** covers the pure helpers with no network and no stack. Picked up
  automatically by the root `"test"` script (`node --test scripts/*.test.mjs`).
- **`docs/standards/performance.md`** is the durable half: what each budget means, the run procedure, the
  resource rules, the pre-committed diagnosis rules, and the already-satisfied audit.
- **`package.json`** gains `perf:bench`.

### Scenarios the harness generates and samples

| Scenario | Fixture | Sampling |
|---|---|---|
| `api.notes.create` | 1000 notes, `parentId` chained 8 deep then fanned out | recorded during `seed` — generation *is* the measurement |
| `api.notes.read` | includes one ~200 KB TipTap document | 30 samples; every fifth read is the large document |
| `api.notes.list` | same corpus | 30 samples across 10 pages at the 100-row cap |
| `api.tasks.list` | 2000 tasks across four statuses, every fourth bound to a note | 30 samples, one per status in rotation |
| `api.search` | search corpus polled until the indexed total settles | 30 samples across three query shapes |
| `ws.propagation` | 4 concurrent editors on one note | 20 Yjs updates, writer emit → reader `realtime:note:remote` |
| `job.export.wait` | single-note PDF | 4 rounds × 5 concurrent exports = 20 samples |
| `bulk.upload` | — | **SKIPPED**, see below |

## Important Decisions

- **Zero optimizations were added, on purpose.** Most of Part 77's "add X" list is already satisfied (audit
  below). Adding a cache, an index, or a windowing library without a failing measurement is precisely what
  the part's own verification clause forbids, and it destroys the evidence that the thing was ever slow.
  The expected diff for this part was harness + budgets + docs, and that is what it is.
- **A server-side `getOrSet` cache is genuinely absent and was deliberately not added.**
  `apps/api/src/infrastructure/redis/redis.service.ts` has no such helper. `docs/standards/performance.md` pre-commits the
  one place it would be justified — the authorization hop inside `api.search` — *if and only if* that hop
  is shown to be the slow half of a missed `api.search` budget.
- **Generation goes through the real API, not raw SQL.** Raw inserts would produce no Meilisearch
  documents, no version snapshots and no idempotency rows, so `api.search` would measure an empty index and
  `api.notes.read` a database that does not resemble production. The side benefit is that generation *is*
  the `api.notes.create` sample set, so `run` never writes a second thousand notes.
- **`seedDatabase()` was rejected as the generator.** `apps/api/src/database/seed.ts` writes a fixed set
  keyed by `SEED_IDS` with no volume parameter, and writes **no Better Auth credential accounts** — no
  seeded identity can sign in. It is a fixture, not a generator.
- **A session, never an API key.** The API-key rate-limit tier is 100/min against 1000/min for an
  authenticated session; generating a thousand notes through the key tier would trip the limiter and void
  its own run.
- **p95 is nearest-rank, never interpolated**, over at least 20 samples. An interpolated percentile is a
  number the server was never observed to produce, and a budget is a claim about observed behavior. Fewer
  than 20 samples reports `VOID` rather than a number.
- **A 429 makes a run `VOID`, not `FAIL`.** Samples taken while the server was refusing work understate
  every budget, and reporting them as a missed budget would send someone optimizing a path that was never
  sampled. `VOID` outranks `FAIL` in the status comparator for this reason.
- **The `seed` → `run` handover is a state file in the OS temp directory**, not in the repository: a state
  file under `scripts/` would eventually be committed and would then point a later run at a workspace that
  no longer exists.
- **No results file is written.** A checked-in results table rots into a claim about hardware nobody still
  has. The table is pasted into this record, next to the host it was taken on.
- **`socket.io-client` and `yjs` are resolved through `apps/web`'s resolution root**, not by bare specifier:
  pnpm does not hoist them to the repository root (verified — `node_modules/socket.io-client` does not
  exist, `apps/web/node_modules/socket.io-client` does). The import is dynamic and guarded, so an
  uninstalled workspace degrades `ws.propagation` to a `SKIPPED` row instead of aborting the run.

## Files and Components

| Path | Purpose |
|---|---|
| `scripts/perf-budgets.json` | Every performance number, with a justification per scenario. The only place a budget lives. |
| `scripts/perf-bench.mjs` | The `seed` / `run` harness. Plain external HTTP + Socket.io client; no Nest context, no new dependency. |
| `scripts/perf-bench.test.mjs` | Pure checks on the percentile, comparator, formatter, and argument clamping. No network. |
| `docs/standards/performance.md` | Durable standard: budget meanings, run procedure, resource rules, diagnosis rules, already-satisfied audit. |
| `package.json` | Adds `perf:bench`. |
| `docs/completed-parts/part-77-performance-scale-limits.md` | This record. |
| `docs/completed-parts/README.md` | One appended index row. |

## Database and Data Changes

None. The harness creates rows only through the public API, only in the disposable `notted_e2e_test`
database, and adds no schema, migration, or seed change.

## API, Configuration, and Operational Changes

- No new or changed routes, contracts, events, or queues.
- New root script `pnpm perf:bench` (`node scripts/perf-bench.mjs`).
- Environment read by the harness, all optional with `e2e`-profile defaults: `PERF_APP_URL`
  (`http://localhost:3010`), `PERF_API_URL` (`http://localhost:3011`), `PERF_MAILPIT_URL`
  (`http://localhost:8025`). The defaults deliberately point at the **disposable** stack, never the
  development stack — benchmarking the latter would fill a developer's database with thousands of rows.
- **Corrected during review:** the harness originally read `PLAYWRIGHT_MAILPIT_URL` and defaulted it to
  `http://localhost:8125`. Both were wrong. `PLAYWRIGHT_MAILPIT_URL` is documented repo-wide as the
  **container-internal** `http://mailpit:8025` (`scripts/dev-tooling.mjs`), which an out-of-container
  script cannot reach, and `8125` is *this* checkout's untracked `.env` override, not the project default
  (`compose.yaml`, `.env.example` both say `8025`). On any other clone `seed` would have hung for 30 s and
  then thrown. The harness now reads its own `PERF_MAILPIT_URL`; on this host the runs below were taken
  with `PERF_MAILPIT_URL=http://localhost:8125` because of that local port shift.
- No production impact: nothing in `apps/api` or `apps/web` changed.

## Security and Tenant-Isolation Notes

- The harness is an **external HTTP client** and holds no privilege a browser does not. It provisions its
  own throwaway tenant, sends a real `Origin` header and a real `Idempotency-Key`, and every request it
  makes passes the same authentication, authorization, and workspace-scope guards as the web client. It
  deliberately does not boot a Nest context, which would let it skip exactly those guards and measure a
  path no user can reach.
- No credential is checked in: the account email is a per-run UUID at `example.test` and the password is a
  policy-meeting constant already used by the browser fixtures. The session cookie lives only in the OS
  temp state file for the life of a run.
- No new security surface, no new dependency, no change to any policy.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `node --test scripts/perf-bench.test.mjs` | **Pass** | 13 tests, 13 pass, 0 fail (was 8; the review added the corpus-probe, `run`-flag and large-document-fixture cases). |
| `pnpm lint` | **Pass** | 4 packages, 0 warnings. |
| `pnpm format:check` | **Pass** | All matched files. |
| `pnpm type-check` | **Pass** | 6 tasks. |
| `pnpm test` | **Pass** | api 2676+, web 1779, shared 448, root scripts 33 — 0 failures. |
| `pnpm build` | **Pass** | With the required HTTPS `NEXT_PUBLIC_*` prefixes. |
| `node scripts/perf-bench.mjs seed --notes=1000 --tasks=2000` | **Pass** | Against the `e2e` stack. Two defects had to be fixed before it could complete at all; see below. |
| `node scripts/perf-bench.mjs run` | **Ran; one budget missed** | Table below. `job.export.wait` FAILs; every other measured scenario passes with wide headroom. |
| `node scripts/perf-bench.mjs seed --notes=1000 --tasks=2000` (re-run 2026-08-26) | **Pass** | Needed `PERF_MAILPIT_URL=http://localhost:8125`: this checkout maps Mailpit's UI to host port **8125**, while the harness still defaults to 8025 (`scripts/perf-bench.mjs:337`). Left as-is rather than changed, since the default is correct for an unshifted checkout — but it is the first thing a reviewer will hit. |
| `node scripts/perf-bench.mjs run` (re-run 2026-08-26, with per-stage instrumentation) | **Pass — every measured scenario within budget** | `job.export.wait` n=20, min 1568, p50 2053, p95 2591 ms against 30,000 ms. Other rows unchanged in shape: `api.notes.create` p95 62, `api.notes.list` 12, `api.notes.navigation` 12, `api.notes.read` 18, `api.tasks.list` 11, `api.search` 19, `ws.propagation` 6 — all with wide headroom. |
| Single export on an empty queue, warm stack (3 samples) | **Ran** | 16,505 / 3,447 / **1,103** ms submit-to-ready, of which 15,779 / 3,340 / 926 ms was queue wait. Retires the carried-forward 40.7 s figure. |

### Two defects the first real run exposed

The harness had **never been executed** before this review, and `seed` could not complete:

1. **The large-document fixture was invalid.** `LARGE_DOCUMENT_PARAGRAPHS = 380` was sized against
   `NOTE_DOCUMENT_LIMITS.maxTotalText` (200000) alone and violated `maxChildren` (200), which caps the
   direct children of the `doc` node. Every `seed` died on `POST /notes` with a bare `VALIDATION_ERROR`.
   Now 190 paragraphs × 1000 characters — the same ~191 KB of prose under *all* the limits — with
   `scripts/perf-bench.test.mjs` asserting children, total text, longest string and serialized bytes so
   it cannot rot again.
2. **The corpus-settle poll could not be satisfied.** The original `limit=1` poll settled at
   `total === 1` in about three seconds because `SearchPage.total` counts items on *this page*, not the
   corpus. The obvious replacement — page 10 of 100 — is **structurally impossible**: `MAX_CANDIDATES`
   in `apps/api/src/search/search.service.ts` is 200, so the search API can never surface an authorized
   result past index 200 and page 3 of 100 is empty forever. The poll now walks to the deepest page the
   API *can* fill (page 2 of 100) and holds it across two consecutive reads. That proves **at least 200
   documents are searchable**, which is the strongest claim an external client can make here, and the
   seed line says exactly that rather than implying a corpus count.

### Benchmark results — measured 2026-08-26

Fixture: 1000 notes (8-deep spine) + one large document, 2000 tasks, 200 documents reachable through the
search API. Target `http://localhost:3011` (`api-e2e`). All times in milliseconds.

| Scenario | n | min | p50 | p95 | max | errors | 429s | budget | status | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `api.notes.create` | 1001 | 17 | 38 | 78 | 417 | 0 | 0 | 400 ms | **PASS** | |
| `api.notes.list` | 30 | 8 | 11 | 17 | 53 | 0 | 0 | 200 ms | **PASS** | |
| `api.notes.navigation` | 30 | 7 | 10 | 14 | 16 | 0 | 0 | 500 ms | **PASS** | New in this review; see the virtualization row below. |
| `api.notes.read` | 30 | 7 | 10 | 16 | 17 | 0 | 0 | 300 ms | **PASS** | Every fifth read is the ~200 KB document. |
| `api.tasks.list` | 30 | 7 | 9 | 16 | 16 | 0 | 0 | 250 ms | **PASS** | |
| `api.search` | 30 | 14 | 16 | 20 | 29 | 0 | 0 | 300 ms | **PASS** | |
| `ws.propagation` | 20 | 4 | 5 | 7 | 8 | 0 | 0 | 1000 ms | **PASS** | Real Yjs propagation; the heartbeat fallback did **not** engage. |
| `job.export.wait` | 20 | 41289 | 42753 | **69242** | 69253 | 0 | 0 | 30000 ms | **FAIL** | **Superseded 2026-08-26.** Re-measured with per-stage instrumentation as `n=20, min 1568, p50 2053, p95 2591` — **PASS**. Fully attributed below; the earlier figures were outbox pickup latency, not export work. |
| `bulk.upload` | 0 | — | — | — | — | 0 | 0 | none | SKIPPED | 50 × 2 MiB deliberately not attempted on this host. |
| `web.firstLoadJs` | 0 | — | — | — | — | 0 | 0 | 350 kB | **NOT MEASURED** | Next 16.2.11 prints no First Load JS column and its Turbopack output has no `app-build-manifest.json`. |
| `editor.inputLatency` | 0 | — | — | — | — | 0 | 0 | none | **NOT MEASURED** | Needs a production web build (Phase 15). |
| `web.interactionLatency` | 0 | — | — | — | — | 0 | 0 | none | **NOT MEASURED** | Same blocker. |
| `web.firstLoadRuntime` | 0 | — | — | — | — | 0 | 0 | none | **NOT MEASURED** | Same blocker. |

**Host honesty statement (required alongside any numbers).** Measured on
`Linux 6.18.33.2-microsoft-standard-WSL2 x86_64`, 6 logical CPUs, **8.9 GB total RAM with ~3–5 GB free**,
Docker daemon **shared with another project**, `web-e2e` serving `next dev` on the same machine. This is
**not VPS-class** and is not the machine `scripts/perf-budgets.json` describes. Every number above is a
**floor**: good enough to catch a regression, worthless as a certification.

### `job.export.wait` — instrumented, and the ~36 s is now fully attributed

**Closed 2026-08-26 by the residual-closure session.** The earlier disposition was *measured, over
budget, cause not established*, owned by Phase 15 with instrumentation as its first task. That
instrumentation was written and run. The answer is that **`job.export.wait` was never measuring export
work.**

#### What the instrumentation is

Per-stage `performance.now()` marks, logged once on the success path, no metric and no branch:

| Where | Field |
|---|---|
| `apps/api/src/export/export.worker.service.ts` | `queueWaitMs` (export row committed → handler pickup), `claimMs`, `authorizeMs`, `sourceLoadMs`, `renderMs`, `uploadMs`, `markReadyMs`, `announceMs`, `handlerMs` |
| `apps/api/src/export/pdf-export.service.ts` | `pageAcquireMs`, `pageConfigureMs`, `setContentMs`, `pdfMs`, on the existing "PDF export blocked outbound requests" line |
| `apps/api/src/export/export.service.ts` | `ExportClaim.createdAt`, carried solely so `queueWaitMs` can be computed |

`queueWaitMs` is the one wall-clock delta (PostgreSQL's `created_at` against the API process's clock);
both run on the same host, so the skew is orders of magnitude below what it measures. Everything else is
monotonic.

#### The measurement — `perf-bench run`, same fixture, same `e2e` stack, n = 20

| Stage | min | p50 | max |
|---|---|---|---|
| **`queueWaitMs`** | **1,136** | **1,594** | **2,208** |
| `claimMs` | 1 | 2 | 8 |
| `authorizeMs` | 1 | 1 | 6 |
| `sourceLoadMs` | 0 | 0 | 4 |
| `renderMs` | 79 | 110 | 312 |
| `uploadMs` | 4 | 6 | 20 |
| `markReadyMs` | 2 | 2 | 3 |
| `announceMs` | 4 | 5 | 7 |
| **`handlerMs`** (everything the job does) | **93** | **126** | **332** |

Inside `renderMs`, over the same 20 jobs:

| PDF sub-stage | min | p50 | max |
|---|---|---|---|
| `pageAcquireMs` (incognito context + `newPage`) | 39 | **64** | 251 |
| `pageConfigureMs` | 2 | 3 | 8 |
| `setContentMs` | 2 | 3 | 8 |
| `pdfMs` | 26 | 34 | 47 |

**The whole export job is ~126 ms at p50.** Rendering a single-note A4 PDF is 110 ms, of which the
largest component is acquiring a browser context (64 ms), and actually printing is 34 ms. Storage upload
is 6 ms. Roughly **93 % of the measured wall time is `queueWaitMs`** — the delay between the export row
committing and the outbox dispatcher picking the intent up. Nothing in the export pipeline is slow.

#### Why the wait was 41–69 s, named

`OutboxDispatcherService.dispatchOnce` claims a fixed batch — `QUEUE_DISPATCH_BATCH_SIZE`, default
**100** — every `QUEUE_DISPATCH_INTERVAL_MS`, default **1,000 ms**, ordered by `(available_at,
created_at)`. Its own comment states the design: *"Unknown definitions and known definitions without a
concrete consumer remain durable pending intent. This is the rollout safety gate."* An intent with no
registered consumer is claimed and then `releaseUnhandled`d, which pushes `available_at` forward by
`QUEUE_DISPATCH_STALE_CLAIM_MS` (default **30,000 ms**) and leaves it `pending`.

The perf fixture creates 1,000 notes and 2,000 tasks, and each emits a `note.created` / `task.created`
intent for which **no consumer is registered**. Measured directly on the `e2e` database after seeding:

```
 job_type      | status    | count
 task.created  | pending   |  2000     attempt_count 0, available_at rolling ~30 s ahead
 note.created  | pending   |  1001     attempt_count 0, available_at rolling ~30 s ahead
```

**3,001 rows recycling on a 30 s deferral is 100 rows per second of dispatcher work — exactly the
dispatcher's entire capacity** (100 rows per 1,000 ms tick). That is not a coincidence: `batchSize ×
(staleClaimMs / intervalMs)` = 100 × 30 = 3,000 is the saturation point, and the fixture sits on it.

Immediately after seeding, all 3,001 rows carry `available_at = now()` and sort *ahead* of a
just-created export intent, so an export queues behind up to the whole backlog: 3,001 / 100 per second
≈ 30 s, which is the order of the 41 s floor and the 69 s p95 recorded above. As the deferral spreads
them out, the wait collapses.

That collapse was measured directly (see the single-export figures below): three exports submitted one
at a time, minutes apart, waited **15,779 ms → 3,340 ms → 926 ms** in the queue while doing **608 ms →
109 ms → 101 ms** of actual work.

With the backlog spread out, the same scenario now reads:

| Scenario | n | min | p50 | p95 | max | budget | status |
|---|---|---|---|---|---|---|---|
| `job.export.wait` | 20 | 1568 | 2053 | 2591 | 2591 | 30000 ms | **PASS** |

**No optimization was made.** No warm pool was added (one already exists), no budget was edited, no
concurrency was changed, and the export path is byte-identical apart from the timing marks. The row
moved from FAIL to PASS because the fixture's outbox backlog had drained, which is itself the finding.

#### Retracted: the 40.7 s single-export figure, and the 4.65 s bare render

**Both are withdrawn as descriptions of export cost.**

Measured directly, on an empty queue, warm stack (`scratchpad/single-export.mjs`, three exports
submitted one at a time):

| Run | submit → ready | of which `queueWaitMs` | of which `handlerMs` | `renderMs` |
|---|---|---|---|---|
| 1 (Chromium cold) | **16,505 ms** | 15,779 | 608 | 587 |
| 2 (warm) | **3,447 ms** | 3,340 | 109 | 83 |
| 3 (warm) | **1,103 ms** | 926 | 101 | 81 |

- **A single warm export is ~1.1 s end to end and ~100 ms of work. It is not 40.7 s.** The carried-forward
  figure is deleted rather than re-stated; it described a queue, not an export.
- **A cold Chromium launch costs about 0.5 s, not tens of seconds** — `renderMs` 587 cold against 81
  warm. The earlier session was right to retract "cold start" as the cause; it is now also quantified.
- **The 4.65 s "bare A4 render"** from `export-pdf.integration.test.ts` is not the render cost either. A
  real render in the running service is **79–312 ms**. Whatever that 4.65 s covered, it included fixed
  cost outside the render, and it must not be used as the export baseline again.

#### What is genuinely open, and is NOT this part's to fix

**Unhandled outbox intents accumulate without bound and saturate the dispatcher.** This is not two job
types. It is **every domain-event job type with no registered consumer** — **19 of them measured on the
developer's own `notted_dev` database**, 2,783 pending rows, all at `attempt_count 0`, with 2,752 of
them touched inside the preceding two minutes and their `available_at` values rolling forward in a
31-second band. `note.created` (1,214), `note.moved` (657) and `note.updated` (595) lead it; the perf
fixture only ever surfaced `note.created` / `task.created` because those are what it generated. Every
row ever written for such a type is re-claimed and re-deferred forever, at a steady cost of
`count / 30 s` rows per second against a fixed 100 rows/second budget — ~92 rows/s measured, against a
budget of 100. Past roughly 3,000 such rows the dispatcher has no capacity left for anything else, and the
pickup latency of *every* real job — exports, email, search indexing — degrades without bound. That is
the "rollout safety gate" behaving exactly as written, with no reaper behind it.

**Fixed 2026-08-26**, after this record was written, in the residual-closure session: the subscriber-aware
skip, plus the reaper. The 27 domain-event types now carry a static `consumer: "none"` marker on their
job definition; `claimBatch` excludes marked types outright, so they cost no dispatch capacity at any
depth, and the existing `queue.idempotency.cleanup` sweep cancels marked rows past
`QUEUE_OUTBOX_RETENTION_DAYS` and deletes terminal `job_outbox` rows past the same age — the latter being
the only thing that has ever bounded ordinary `completed` growth. The marker is static rather than read
from `QueueHandlerRegistry` because that set is per process and Phase 15 splits API and worker: a
registry-driven rule would strand or cancel intents the other process handles. The rollout safety gate is
untouched for types that carry no marker. It still means **`job.export.wait` is partly a measure of outbox
hygiene**, which anyone reading a future regression in that row should know before looking at the export
code.

### Command sequence for the reviewer

```
pnpm infra:down
docker compose --profile e2e build api-e2e
pnpm e2e:up
node scripts/perf-bench.mjs seed --notes=1000 --tasks=2000
node scripts/perf-bench.mjs run
```

`pnpm infra:down` first is not optional: the `e2e` profile lives in the *same* Compose project, so
`pnpm e2e:up` would otherwise start `api-e2e`/`web-e2e` **alongside** a running development stack rather
than replacing it. Pre-building `api-e2e` as its own foreground step keeps the ~1.45 GB Chromium image
build from racing the benchmark for memory.

## Known Limitations and Follow-up Work

- **RESIDUAL 1 — no measurement on VPS-class hardware.** Part 77's Verify clause names the hardware, and
  this project has none before Phase 15. Every number in this record was taken on WSL2 with 6 logical
  CPUs, 8.9 GB RAM, a shared Docker daemon and `next dev`. They are a floor for regression detection and
  are **not** a certification of any budget, pass or fail.
- ~~**RESIDUAL 2 — `job.export.wait` misses its budget and the cause is not established.**~~ **Closed
  2026-08-26.** Per-stage instrumentation was added to the export worker and the PDF renderer and the
  scenario re-run: **~93 % of the wall time is `queueWaitMs`**, the outbox dispatcher's pickup delay, and
  the export job itself is **126 ms at p50**. The ~36 s gap was never in the export path. The scenario
  now reads `n=20, min 1568, p50 2053, p95 2591` against 30,000 ms — **PASS**, with no optimization made
  and no budget edited. Full attribution above.
- ~~**RESIDUAL 3 — unhandled outbox intents saturate the dispatcher, and nothing reaps them.**~~
  **Closed 2026-08-26.** The count was understated twice: it is **27 domain-event job types**, not 19 and
  not 2, and all 27 have live producers in `NotesService`, `NoteSharesService`, `ProjectsService`,
  `TagsService`, `TasksService` and `AttachmentsService`. Two changes closed it. `claimBatch` now excludes
  job types declared `consumer: "none"`, so an unconsumable row costs no dispatch capacity at any depth;
  and the `queue.idempotency.cleanup` sweep cancels marked rows past `QUEUE_OUTBOX_RETENTION_DAYS`
  (default 30) and deletes terminal rows past the same age. `workspace.deleted` is deliberately **not**
  marked — it is one row per workspace deletion and is not built by `actorDefinition`, and being
  conservative there costs nothing while being wrong would cancel a cleanup intent.

  **Measured after the change, on the same development database that produced the original number.**
  2,863 pending rows, of which 2,792 are marked domain events: those are now completely static — over
  repeated two-minute windows, zero of them are touched. The only rows still recycling are the **71
  `workspace.deleted`** intents, the type deliberately left unmarked, at `71 / 30 s` = **~2.4 rows per
  second against the 100 rows/second budget** — down from **~92**, i.e. from 92 % of the dispatcher's
  capacity to 2.4 %. The `claimBatch` and sweep SQL were both executed against PostgreSQL inside a rolled
  back transaction before shipping (`UPDATE 500`, `DELETE` clean), because drizzle expands a bare array
  parameter into one placeholder per element and would have produced `any(($1, $2, …)::text[])` — invalid
  SQL that no unit test using a fake `execute` would have caught. Both call sites use `sql.param`, and
  both have a regression test asserting the single `$n::text[]` placeholder.

  **`workspace.deleted` remains an open, quantified exception.** It has a definition, a producer
  (`workspaces.service.ts:662`) and no consumer, and the sweep does not retire it, so its rows accumulate
  at one per workspace deletion and keep recycling at that rate. That is bounded by how often workspaces
  are deleted, is three orders of magnitude below the saturation point, and is visible the whole time
  under `notted_job_outbox_rows{consumable="no"}`. Marking it too is a one-line change the day someone
  confirms nothing is ever going to consume it.

  The original measurement, kept because it is what justified the work:
  re-defers every such row forever at `count / QUEUE_DISPATCH_STALE_CLAIM_MS` rows per second against a
  fixed `QUEUE_DISPATCH_BATCH_SIZE / QUEUE_DISPATCH_INTERVAL_MS` = 100 rows/second budget. Past ~3,000
  such rows the dispatcher has nothing left for real work and **every** job's pickup latency degrades
  without bound. Measured twice: on the seeded `e2e` fixture, 3,001 recycling rows with export pickup at
  15.8 s falling to 0.9 s as they spread out; and on the **development** database during round-2 review,
  2,783 pending rows across 19 types churning at ~92 rows/s — i.e. this is the product's ordinary steady
  state, not a fixture artefact, and a real deployment crosses the saturation point in weeks of normal
  use. Part 78's `NottedOutboxStuck` alert is scoped to `consumable="yes"` precisely so this backlog
  cannot page an operator who has nothing to fix, and that scoping is unchanged: the marked rows still
  report under `consumable="no"`. A future regression in `job.export.wait` should still be read as outbox
  hygiene first and export code second.

### Scenarios with no number, and why

| Scenario | State | Blocker |
|---|---|---|
| `editor.inputLatency` | `null` | Needs a **production web build**. `web-e2e` runs `next dev`, where a keystroke can sit behind an on-demand route compile. Unblocks in **Phase 15**. |
| `web.interactionLatency` | `null` | Same blocker. Click-to-paint on `next dev` measures compilation, not the shipped bundle. **Phase 15**. |
| `web.firstLoadRuntime` | `null` | Same blocker, and the sharpest case: `next dev` serves unminified modules behind a per-request compile, so the number would be wrong by a multiple. The build-time proxy `web.firstLoadJs` stands in until **Phase 15**. |
| `bulk.upload` | `SKIPPED` | Deliberate, host-specific, not blocked upstream. MinIO multipart traffic plus a Puppeteer-capable API container competing for this host's free memory is not a combination to ask for. The harness records the volume it would have used (50 × 2 MiB). Measure on VPS-class hardware. |
| `web.firstLoadJs` | `SKIPPED` (the harness's own label; this record's earlier text said `NOT MEASURED` — the blocker is identical either way) | **Blocked, not merely deferred.** The stated method — read the First Load JS column of `next build` — no longer exists: Next 16.2.11 prints no size table, and its Turbopack build output carries no `app-build-manifest.json` to derive a per-route figure from. A summed-chunk approximation would be a different metric wearing this budget's name, so the cell stays empty. Unblocks with a bundle-analyzer step or a Next release that restores the column. |
| `ws.propagation` | may report a **fallback** | If the Yjs sync/epoch handshake yields no samples within a bounded number of attempts, the harness samples the `realtime:heartbeat` ack round-trip instead and labels the row `FALLBACK: heartbeat ack round-trip, NOT end-to-end propagation` **and reports `NOT MEASURED` rather than scoring it** — a fast heartbeat must never certify a propagation budget nobody measured. |

### Other follow-ups

- No server-side response cache exists (`RedisService` has no `getOrSet`). Justified only if a missed
  `api.search` budget is traced to the authorization hop; see the diagnosis rules in the standard.
- ~~The harness has never been executed.~~ It has now: `seed` and `run` both completed against the `e2e`
  stack on 2026-08-26, which is where the two defects above were found. Its HTTP shapes had been verified
  only against `docs/openapi.json` and the controllers, which is exactly why the fixture-validation and
  corpus-settle bugs survived to the first run.
- On a memory-capped host, a `p95` miss may be contention rather than a defect. Re-run the scenario alone
  before recording it as a finding.

## The already-satisfied audit

Checked before writing anything, and recorded here so nobody re-adds any of it without a failing row.

| Part 77 asks for | State | Evidence |
|---|---|---|
| Pagination | **Already satisfied** | `packages/shared-validators/src/common.schema.ts:65-69` — `paginationQuerySchema` limit `min(1).max(100).default(25)`; every list schema re-asserts `max(100)`; search `limit` defaults to 8 with a 100-character query cap. |
| Payload limits | **Already satisfied** | `apps/api/src/main.ts:200-205` — `json({ limit: config.requestBodyLimitBytes, strict: true })`, with Nest's own parser disabled at `:50`. Default 1 MiB via `REQUEST_BODY_LIMIT_BYTES`. |
| Indexes | **Already dense** | 13 `index()` declarations in `apps/api/src/database/schema/notes.ts`, 6 in `auth.ts`, 4 in several others. |
| Backpressure | **Already satisfied** | Four rate-limit tiers under `apps/api/src/common/rate-limit/`; `acquireBoundedLease`/`releaseLease` in `apps/api/src/infrastructure/redis/redis.service.ts`; per-socket leases plus `realtime-rate-limit.service.ts`; BullMQ concurrency; mandatory idempotency keys on the expensive POSTs. |
| Virtualization | **NOT NEEDED — on evidence, after a corrected premise** | The original entry read "every list is page-capped at ≤100 rows", and that was **false**. `apps/web/src/lib/notes/server-notes.ts:141` requests the sidebar tree with `?limit=500` against a schema ceiling of 1000 (`packages/shared-validators/src/note.schema.ts:200-211`), and `apps/web/src/components/notes/NoteTree.tsx:172` renders every returned row on every dashboard page — the largest list in the product, and the one the audit had not looked at. It now has its own budget and its own measurement: `api.notes.navigation`, p95 **14 ms** against 500 ms, over a 1001-note fixture. So virtualization stays out of scope because a measurement says so, not because of a claim that was not true. `apps/web/src/components/notes/NoteTimeline.tsx:36-45` still records its own deferral in a `ponytail:` comment. |
| Caching | **Absent server-side — deliberately not added** | `apps/api/src/infrastructure/redis/redis.service.ts` has no `getOrSet`, and no server-side response cache exists. The unqualified "genuinely absent" was too broad: `apps/web/src/app/ReactQueryProvider.tsx:13` sets a 30-second TanStack Query `staleTime` (client-side, per browser tab), and `apps/api/src/attachments/attachments.controller.ts:299` serves attachment bytes as immutable for a year (HTTP cache, on content addressed by a stable key). Neither is a shared server-side result cache, which is the thing the standing rule exists to stop being added speculatively. |

## Handoff Notes

- **The budget file is the API.** Change a number there, never in prose. `scripts/perf-bench.test.mjs`
  asserts that the three production-build-blocked budgets stay `null` with a stated blocker and that every
  budget carries a real justification — so a number added carelessly fails the test, not just review.
- **Part 78 (observability) is the natural consumer.** The scenario ids here are the obvious names for
  latency histograms; keeping them identical means a dashboard and this table can be compared directly.
- **Phase 15 unblocks three budgets.** When a production web image exists, fill in `editor.inputLatency`,
  `web.interactionLatency`, and `web.firstLoadRuntime`, and stop treating `web.firstLoadJs` as their proxy.
- **Startup order matters.** `seed` needs the API, PostgreSQL, Redis, Meilisearch and **Mailpit** all up;
  it fails at the verification step with a clear message if Mailpit is unreachable. The harness defaults to
  the project's published Mailpit port `8025`; **this particular checkout** shifts it to `8125` in an
  untracked root `.env` to avoid a port clash with another project. Since 2026-08-26 the default follows
  `NOTTED_MAILPIT_WEB_PORT` — the same variable `compose.yaml` publishes from — so a shifted checkout is
  correct without an override, and `PERF_MAILPIT_URL` still wins when set. Do not hard-code either number.
- **`ws.propagation` is the fragile scenario.** It is time-boxed on purpose. If it degrades to the
  heartbeat fallback repeatedly, fix the handshake and re-run rather than lowering the budget — and never
  compare a fallback number to the propagation budget.
- **Re-seed rather than reusing a stale state file.** `run` reads a session cookie and note ids from the
  temp state file; the `e2e` stack resets its database on every `pnpm e2e:up`, so a state file older than
  the current stack points at rows that no longer exist.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-26 | Backend/platform agent, session `3fb3cda0` | Initial record. Harness, budgets, standard and check implemented; benchmark not yet run, so state is In progress. |
| 2026-08-26 | Review-remediation session `3fb3cda0` | First real execution. Fixed the invalid large-document fixture and the unsatisfiable corpus-settle poll, corrected the Mailpit variable and default, added the `api.notes.navigation` scenario and budget after the virtualization premise was found to be false, qualified the caching claim, and recorded the measured table with its host statement. `job.export.wait` misses its budget and is diagnosed to Puppeteer launch cost; state stays **In progress** for that reason. |
| 2026-08-26 | Residual-closure session `3fb3cda0` | **Instrumented the export path and closed RESIDUAL 2 without optimizing anything.** Added per-stage timings to `export.worker.service.ts` and `pdf-export.service.ts` (and `ExportClaim.createdAt` to compute queue wait), re-ran the scenario, and attributed the whole gap: `queueWaitMs` p50 1,594 ms against `handlerMs` p50 126 ms — ~93 % of the wall time is outbox pickup and the export job is fast. Named the mechanism: `note.created`/`task.created` have no consumer, so 3,001 rows recycle on a 30 s deferral against a 100 rows/second dispatch budget, exactly saturating it. Row moves FAIL → **PASS** (p95 2,591 ms) with the budget untouched. **Retracted the 40.7 s single-export figure on measurement** — a warm single export is **1,103 ms** — and retracted the 4.65 s "bare A4 render" as an export baseline (a real render is 79–312 ms). Recorded the unreaped-outbox saturation as a new residual, deliberately not fixed. |
| 2026-08-26 | Review-remediation session `3fb3cda0` (second pass) | Disposed of the one failing budget without touching it. **Retracted the "Puppeteer cold start" diagnosis**: `browser-pool.service.ts:35` already keeps one Chromium warm for 60 s of idle and the benchmark never idles that long, so at most 1 of the 20 samples paid a launch and a warm `min` of 41,289 ms cannot be launch cost; `QUEUE_DISPATCH_INTERVAL_MS` is 1000 ms, so dispatch is not it either. Recorded as **measured, over budget, cause not established**, owned by Phase 15 with instrumentation — not optimization — as the first task there. Made `scripts/perf-budgets.json`'s `why` and `docs/standards/performance.md`'s triage rule consistent with that, including a standing "do not add a warm pool, it already exists" note. The 40.7 s single-export figure is marked carried-forward and unverified. **State flipped to Complete** on the scope this hardware allows. |
| 2026-08-26 | Residual-closure session `3fb3cda0` | **Closed RESIDUAL 3.** The unconsumed-outbox backlog is 27 domain-event job types, all with live producers, not 19 and not 2. `claimBatch` now excludes types declared `consumer: "none"`, so they draw no dispatch capacity at any depth, and the `queue.idempotency.cleanup` sweep cancels marked rows and deletes terminal `job_outbox` rows past `QUEUE_OUTBOX_RETENTION_DAYS` (default 30) — the first thing to bound that table at all. The marker is static per job type, not read from the per-process `QueueHandlerRegistry`, so Phase 15's API/worker split cannot strand or cancel another process's intents; `workspace.deleted` is deliberately unmarked. The rollout safety gate is untouched for unmarked types. Also fixed the benchmark's Mailpit default to follow `NOTTED_MAILPIT_WEB_PORT`. |
