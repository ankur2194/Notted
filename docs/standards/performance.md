# Performance Standard

The numbers live in [`scripts/perf-budgets.json`](../../scripts/perf-budgets.json) and nowhere else.
This page justifies them, says how to measure them, and states when they may be acted on. If a number
appears in prose here, it has been duplicated by mistake — fix the prose, not the budget file.

## The standing rule

**An optimization requires a failing measurement first.** Not a hunch, not a code review comment, not
"this looks like an N+1". A pagination cap, an index, a cache, a queue, or a windowing library that
lands without a `FAIL` row behind it is speculative complexity: it has to be maintained forever and it
was never shown to buy anything. Adding it also destroys the evidence — you can no longer tell whether
the thing was ever slow.

The corollary matters just as much: a `VOID` row is not a failing measurement. A run that hit an error
or a 429 sampled a refusing server, not a slow one. Fix the run and measure again.

**The 429 path is unreachable against the default target, and is kept anyway.** The `e2e` profile sets
`RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "1000000"` (`compose.yaml`), so the harness's four-in-flight
concurrency cannot trip the authenticated limiter there and no `e2e` run will ever produce a 429-VOID
row. `PERF_API_URL` can point the harness at an environment with production limits, though, and against
one of those a run that quietly averaged in refused requests would report a slow server that was in fact
a throttled client. The code is correct everywhere; it is merely inert here.

## What each budget means

- **`api.notes.list`, `api.tasks.list`** — server time for one page of a list, at the 100-row page cap
  that `paginationQuerySchema` already enforces. These are *interaction* budgets: the number is set by
  when a sidebar stops feeling like it appeared, not by how fast an index scan can be.
- **`api.notes.read`** — one note including its `content` document, which can reach the serialized-bytes
  ceiling in `NOTE_DOCUMENT_LIMITS`. The gap above the list budget is transfer and serialization.
- **`api.notes.create`** — the whole write: note row, version snapshot, idempotency row, and the
  post-commit search-index intent. Writes get more room than reads because they pay a durable commit
  and because the user is already inside a "saving" affordance.
- **`api.search`** — end to end, including the hop that filters hits down to notes the caller may read.
  Held equal to `api.notes.read` because opening a result and opening a note are one interaction.
- **`ws.propagation`** — a remote keystroke, from the writer's emit to the reader's frame. Derived from
  limits the client already commits to in
  `apps/web/src/lib/collaboration/note-collaboration-provider.ts` (handshake budget minus batching
  window, with headroom), so the budget fails before the client's own timeout does. It is never an
  invented round number.
- **`job.export.wait`** — wall time from `POST /exports` to `status: "ready"` for a single-note PDF.
  A capacity promise, not an interaction budget: past it, the UI should stop showing a spinner and
  start offering the artefact by email.
- **`web.firstLoadJs`** — build-time on purpose; timing a bundle on a dev server measures the dev server.
  **Currently unreadable, and recorded as `NOT MEASURED` rather than guessed:** Next 16.2.11 no longer
  prints the "Size / First Load JS" column, and its Turbopack build output carries no
  `app-build-manifest.json` to derive the per-route figure from. A summed-chunk approximation would be a
  different metric wearing this one's name. Unblocks with a bundle-analyzer step, or a Next release that
  restores the column.

### The budgets that are deliberately `null`

`editor.inputLatency`, `web.interactionLatency`, and `web.firstLoadRuntime` are `null` and stay `null`
until a **production web build** exists. `web-e2e` runs `next dev`, where a keystroke can sit behind an
on-demand route compile; a number taken there describes the compiler, not the product. Phase 15 is what
unblocks them. A `null` with a named blocker is honest; a number from `next dev` is not, and it would be
wrong by a multiple rather than by a margin.

`bulk.upload` is `null` for a different reason: skipped on constrained hosts, not blocked upstream. The
harness prints the volume it would have used so the omission stays legible.

## Running the harness

Against the disposable `e2e` stack only — never the development stack, which a benchmark would fill with
thousands of rows a developer then has to look at.

```
pnpm infra:down
docker compose --profile e2e build api-e2e
pnpm e2e:up
node scripts/perf-bench.mjs seed --notes=1000 --tasks=2000
node scripts/perf-bench.mjs run
```

- `seed` provisions its own tenant end to end (register, Mailpit verification, sign in) and generates the
  fixture **through the real API**. Raw SQL would leave no Meilisearch documents, no version snapshots
  and no idempotency rows, so the search and read scenarios would measure a database that does not
  resemble production. Generating through the API is also where the `api.notes.create` samples come from.
- `seed` uses a **session, not an API key**: the API-key rate-limit tier is far tighter than the
  authenticated session tier, and generating a thousand notes through it would trip the limiter and void
  its own run.
- The handover between `seed` and `run` is a state file in the OS temp directory, deliberately outside the
  repository. Re-seed rather than reusing a stale one.
- The harness writes **no results file**. Paste the table into the completion record next to the host it
  was taken on. A checked-in results file rots into a claim about hardware nobody still has.
- `p95` is nearest-rank over at least twenty samples. Fewer than twenty is reported `VOID`, because a
  "95th percentile" of ten numbers is just the maximum wearing a hat.
- `pnpm perf:bench` is the same entry point. `node --test scripts/perf-bench.test.mjs` covers the pure
  helpers and needs no stack at all.

## Resource rules

These are the same constraints as
[`testing.md` → Local resource budget](testing.md#local-resource-budget), and they bind here too.

- **Never run both stacks at once.** `pnpm infra:down` before `pnpm e2e:up`.
- **Pre-build `api-e2e` as its own foreground step**, so the Chromium image build never races the
  benchmark for memory.
- **A memory-capped host is not VPS-class.** Record what you measured on. Numbers from a laptop or a WSL2
  VM sharing a Docker daemon are a floor — useful for spotting a regression, worthless as a certification.
- **Re-run a scenario alone before calling it a miss.** This harness is load-sensitive by design; a p95
  that only misses during a full run is contention, and contention is a finding about the host.
- **Never run the Playwright suite straight after the benchmark.** `seed` writes ~3000 rows through the
  real API, and every one of them dispatches a post-commit intent, so the stack is left with roughly
  **7,000 `pending` rows in `job_outbox`**. Verification email queues behind them and arrives minutes
  late, which times out every spec that provisions an account — measured here as **30 failed specs**,
  all of them at `waiting for authentication mail`, none of them a real defect. Either run the browser
  suite first, or `pnpm e2e:up` between the two (it drops and recreates the database). Check with
  `docker compose -p notted-dev exec -T postgres psql -U notted -d notted_e2e_test -tAc "select status,
  count(*) from job_outbox group by status"` before blaming a spec.

## Pre-committed decision rules

Decided in advance, so a missed budget is answered with a diagnosis instead of an argument.

- **A list scenario misses its p95** → `EXPLAIN ANALYZE` the query first. A sequential scan means exactly
  one index, on the columns the plan actually filtered and sorted on. Not two, not a covering index "while
  we are in here", and not a cache in front of a query that was never explained.
- **`api.search` misses** → find out *which half* is slow before touching anything: the Meilisearch query,
  or the authorization hop that filters hits to readable notes. If it is Meilisearch, it is an index
  settings or filter problem. If it is the authorization hop, that is the **only** place in this system a
  Redis `getOrSet` would currently be justified — the answer is per-user and per-workspace, changes only
  when membership or sharing changes, and is recomputed identically on every hit of every page.
  `apps/api/src/infrastructure/redis/redis.service.ts` has no `getOrSet` today, and it should stay that way until this measurement demands it.
- **`job.export.wait` misses** → **read `queueWaitMs` before you look at the export code at all.**
  The export worker and the PDF renderer now log per-stage timings on the success path
  (`queueWaitMs`, `claimMs`, `authorizeMs`, `sourceLoadMs`, `renderMs`, `uploadMs`, `markReadyMs`,
  `announceMs`, `handlerMs`; and `pageAcquireMs` / `pageConfigureMs` / `setContentMs` / `pdfMs` inside
  the render), so this scenario no longer needs a hypothesis. When this budget was first missed, ~93 %
  of the wall time was `queueWaitMs` and the export job itself was **126 ms at p50** — nothing in the
  render was ever the term.
  - **`queueWaitMs` dominates** → this is the outbox dispatcher, not the export. Check
    `select job_type, count(*) from job_outbox where status='pending' group by 1`. Intents with **no
    registered consumer** are re-claimed and re-deferred forever, costing
    `count / QUEUE_DISPATCH_STALE_CLAIM_MS` rows per second against a fixed
    `QUEUE_DISPATCH_BATCH_SIZE / QUEUE_DISPATCH_INTERVAL_MS` budget — 100 rows/second at the defaults,
    so ~3,000 such rows saturate the dispatcher outright and delay *every* job.
  - **`handlerMs` dominates** → then, and only then, read the render sub-stages. **Do not reach for a
    warm browser: it already exists.** `apps/api/src/export/browser-pool.service.ts` keeps one shared
    Chromium alive for 60 s of idle, so a back-to-back run pays at most one launch, and a cold launch is
    worth about **0.5 s** (`renderMs` 587 cold against 81 warm) — not tens of seconds.
  - **Reference figures, WSL2 development host, single-note A4 PDF:** whole job 126 ms p50; render 110 ms,
    of which browser-context acquisition 64 ms and `page.pdf` 34 ms; upload 6 ms. A single warm export
    end to end is ~1.1 s including queue wait. The 4.65 s figure from
    `export-pdf.integration.test.ts` is **not** the render cost and must not be used as a baseline.
  - Measured numbers on a memory-capped WSL2 host are a floor, never a certification, and a miss there is
    **not** grounds for raising the budget.
- **`api.notes.navigation` misses its p95** → lower the requested `limit` and paginate the tree first.
  This budget measures transfer and serialization of up to 500 projection rows, and virtualization
  changes *render* cost, not transfer cost — reaching for a windowing library here would leave the
  measured number exactly where it was. Only after the payload is bounded, and only if a `FAIL` row
  survives it, does the rendered list become the suspect.
- **`ws.propagation` falls back to the heartbeat round-trip** → the row says so and reports
  `NOT MEASURED` rather than a `PASS`, because a fast server round-trip must never certify a propagation
  budget nobody measured. Fix the handshake and re-run; do not read the fallback number as the budget.

## What is already satisfied

Recorded so nobody re-adds it. As of Part 77, all of the following exist and none of them may be
"improved" without a failing row:

- **Pagination** — `paginationQuerySchema` in `packages/shared-validators/src/common.schema.ts` caps every
  list; each list schema re-asserts the cap; search caps both the result page and the query length.
- **Payload limits** — `apps/api/src/main.ts` installs a strict JSON parser at a configured byte limit and
  disables Nest's own.
- **Indexes** — the note, auth, and tenant schemas under `apps/api/src/database/schema/` are already dense
  with them.
- **Backpressure** — four rate-limit tiers under `apps/api/src/common/rate-limit/`, bounded Redis leases,
  per-socket realtime leases and `realtime-rate-limit.service.ts`, BullMQ concurrency, and mandatory
  idempotency keys on the expensive POSTs.
- **Virtualization** — not needed, and now on evidence rather than on a premise. The premise was "every
  list is page-capped at 100 rows", and it was **false**: the sidebar tree is not. `getServerNoteNavigation`
  (`apps/web/src/lib/notes/server-notes.ts`) requests `limit=500` against a schema ceiling of 1000
  (`packages/shared-validators/src/note.schema.ts`), and `apps/web/src/components/notes/NoteTree.tsx`
  renders every returned row on every dashboard page — the largest list in the product, and the one the
  original audit did not look at. It now has its own budget and its own measurement
  (`api.notes.navigation`), which it passes with wide headroom. `apps/web/src/components/notes/NoteTimeline.tsx`
  records the deferral in a `ponytail:` comment. Add a windowing library when a measurement shows a
  rendered list is slow, not before — and if `api.notes.navigation` is what starts missing, the answer
  below applies before virtualization is discussed at all.
