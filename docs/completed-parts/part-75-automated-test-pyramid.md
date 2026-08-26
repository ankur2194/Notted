# Part 75 — Complete the automated test pyramid

## Status

- **State:** Complete
- **Completed on:** 2026-08-26
- **Implemented by:** Claude Code implementation session, 2026-08-26 (implement-only); gates run and follow-ups closed by review-remediation session `3fb3cda0`, 2026-08-26; the `note-images` flake diagnosed and fixed and the "passes repeatedly" criterion settled by residual-closure session `3fb3cda0`, 2026-08-26
- **Plan reference:** `Plan.md`, Part 75
- **Related records:** [Coverage remediation](coverage-remediation-2026-08-04.md), [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md)

**Completeness statement.** Complete, and the Plan.md Verify clause is now met in **both** halves.

The earlier statement in this slot said the *"the full suite passes repeatedly"* half was **not** met, on
the strength of one baseline that came in at 74 passed / 3 failed. That is no longer where the evidence
sits. The `note-images.spec.ts` flake turned out to be a **real product race with a named cause** — not
host contention — and it is fixed at the root. Two consecutive full chromium baselines from a freshly
reset database now come in at **82 passed / 0 failed / 9 skipped**, 7.9 min and 7.8 min. `print-export.spec.ts:145`
passed in both. See "Full chromium baseline" below for all three runs side by side, including the one
that failed and why.

The 9 skips remain by design (1 OAuth capability gate + 8 `dashboard-shell.spec.ts`) and are not
failures. **Host honesty is unchanged**: this is WSL2, 6 logical CPUs, 8.9 GB RAM, a shared Docker
daemon, and `web-e2e` serving `next dev`. Two green runs on this host are evidence that the suite is
repeatable here; they are not a certification on VPS-class hardware.

## Objective

Plan Part 75 asks for a complete test pyramid — unit, integration against real infrastructure, API
contract, and Playwright journeys — enforcing at least 70% coverage while *prioritizing critical-path
branch coverage over superficial percentages*, and verifying that failed tests keep useful traces
without secrets.

Almost all of that already existed: 189 API unit suites, 42 files under `apps/api/test/`, 155 web
unit tests, 19 Playwright specs, four vitest projects at 70/70/70/70, and a bidirectional OpenAPI
contract test. The work of this part was therefore **not to add another layer** but to close the four
holes where the existing pyramid was reporting success it had not earned:

1. Roughly thirty infrastructure-gated API suites could skip silently and still print green.
2. Role denial was asserted only as a UI affordance; nothing asserted the server refuses.
3. REST/tRPC contract reuse (ADR 0002) was a convention with no test behind it.
4. Coverage was one aggregate number, satisfiable by covering whatever was cheapest.

## Implemented Work

- **`turbo.json` env passthrough widened.** Turbo 2 filters the environment strictly, so anything not
  declared never reaches vitest. `test` and `test:ci` previously declared only `DATABASE_URL`, which
  meant every suite gated on MinIO, Meilisearch, Redis, Mailpit, rate limits, or a feature flag
  skipped in CI while the run reported success. The declared set was derived by grepping
  `process.env.` across `apps/api/test/` and `apps/api/src/**/*.test.ts` (not guessed) and now covers
  `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `APP_ORIGIN`, `AUTH_E2E`, `AUTH_LOCKOUT_ATTEMPTS`,
  `SESSION_REMEMBER_ME_DAYS`, `REALTIME_INTEGRATION`, `EXPORT_CHROMIUM_PATH`,
  `DATA_ENCRYPTION_KEYS`, and the wildcards `MINIO_*`, `MEILISEARCH_*`, `MAILPIT_*`,
  `BETTER_AUTH_*`, `RATE_LIMIT_*`, `FEATURE_*`.
- **`apps/api/test/integration-gates.test.ts`.** Turns the silent skip into one red test: under CI,
  if `DATABASE_URL` is set then `MINIO_ENDPOINT`, `MEILISEARCH_HOST`, and `REDIS_URL` must be set
  too. Gated on `process.env.CI` so a developer running without a stack is unaffected.
- **`apps/web/e2e/accounts.ts`.** The first shared Playwright fixture module since `mailpit.ts`:
  `APP_URL`, `API_URL`, `identity()`, `registerAndSignIn()`, `createWorkspace()`, `inviteAndJoin()`.
  Lifted verbatim from the flows that already work in `collaboration.spec.ts`,
  `workspace-management.spec.ts`, and `search.spec.ts`. **No existing spec was migrated.**
- **`apps/web/e2e/role-denial.spec.ts`.** The one genuine journey gap. Provisions owner, admin,
  editor, viewer in one workspace plus a stranger in their own, then drives every assertion through
  `page.request` — no UI. Covers viewer write/audit denials, editor delete/project/settings/
  invitation/API-key denials, admin delete-workspace and demote-owner denials, and the concealment
  cases. Positive controls are included on purpose (viewer *can* read, admin *can* patch settings,
  the note survives the refused delete) so a wall of 403s cannot be a broken session.
- **`apps/api/test/trpc-rest-parity.contract.test.ts`.** Proves REST and tRPC validate with the same
  schema *object*, statically, by reference identity — no database, no HTTP, no application boot.
  Covers all 39 procedures with a bidirectional inventory assertion.
- **`apps/api/vitest.config.ts` per-path coverage floors** for `src/authorization/**`, `src/auth/**`,
  `src/tenant/**`, `src/common/idempotency/**`, with the global 70 left alone.
- **`docs/standards/testing.md`** gained a delimited Part 75 section: infrastructure gates, the two
  container-specific suites, the shared fixture rule, the exact-status/403-vs-404 rules for denial
  specs, the trace-secret verification procedure, and the coverage-ratchet rule.

## Important Decisions

- **The global coverage threshold was deliberately NOT raised.** Inflating one aggregate is the
  superficial move the plan part explicitly warns against, and it is satisfied by covering whatever
  is cheapest. Per-path floors on the four security-critical directories target the branches where a
  miss is a security bug instead.
- **The per-path floors were 65, a placeholder, not a measurement — now replaced by measured values.**
  The implementing session ran no tests, so no real number was available and none was invented. The
  remediation session measured them and set each floor to the lowest of that path's four metrics,
  rounded **down** to the nearest 5. See "Coverage ratchet — measured" below.
- **Parity is asserted by reference identity, not by shape comparison.** Both transports import the
  same exported schema (`notes.controller.ts` calls `createNoteSchema.safeParse`, `notes.trpc.ts`
  wraps `createNoteSchema` in its input object, `openapi.routes.ts` names the same export), so `===`
  is both the strongest and the cheapest available check. A structural comparison would pass on two
  schemas that had drifted into accidental agreement and would be far slower.
- **The tRPC internals were probed before being relied on**, not assumed. Against @trpc/server
  11.18.0, `_def.inputs` and `_def.output` survive onto built procedures and hold the original schema
  objects. The test asserts that they are still present, so a tRPC upgrade that erases them fails
  loudly instead of degrading the file into a no-op comparing `undefined` with `undefined`.
- **`task.list` is a recorded, deliberate divergence, not a defect.** tRPC uses
  `taskListInputSchema`, REST uses `taskListQuerySchema`: tRPC carries JSON, so a caller writes
  `isCompleted: false` and means the boolean, while REST only ever sees the query-string token
  `"false"`. The tRPC schema is the REST one *widened*, so it is strictly more permissive. The map
  entry inverts its assertion for this row — if the two ever become identical the test fails, forcing
  the note to be removed rather than left to rot.
- **Existing Playwright specs were not migrated to the shared helper.** Their copies diverged for
  real reasons (503 route injection, focus-order assertions, passkey and OAuth variants, deliberate
  UI-form coverage). Rewriting nineteen working specs would trade real coverage for tidiness.
- **The role-denial spec drives no UI.** Provisioning and assertions both go through `page.request`,
  which keeps the spec fast and makes it assert the boundary rather than the affordance.
- **Denial assertions use exact status codes.** "Not 2xx" would let a `429` masquerade as an
  authorization decision. The `e2e` Compose profile raises the limits so five identities cannot trip
  one, but the assertion does not depend on that holding.
- **Route drift is guarded against.** A wrong path returns `404`, which is a *passing* result for the
  concealment assertions, so the spec first checks every path it uses against the OpenAPI document
  the running API serves.
- **`MEILISEARCH_HOST`, not `MEILISEARCH_URL`, is the asserted name.** The application config reads
  `MEILISEARCH_HOST`. `MEILISEARCH_URL` was read only by `hybrid-search.integration.test.ts` and was
  set nowhere in the repository, so asserting it would have failed a correct stack — and, as the
  review found, that suite was not "conditionally skipped" but **permanently dead**. It now gates on
  `MEILISEARCH_HOST` like everything else and runs.

## Files and Components

| Path | Purpose |
|---|---|
| `turbo.json` | `test` and `test:ci` now pass the whole test-infrastructure environment through, with a comment naming which suite each variable gates. |
| `apps/api/test/integration-gates.test.ts` | CI-only guard: `DATABASE_URL` set implies the rest of the stack is configured. |
| `apps/api/test/trpc-rest-parity.contract.test.ts` | Static REST↔tRPC schema-identity contract over all 39 procedures, with a bidirectional inventory assertion. |
| `apps/api/vitest.config.ts` | Adds glob-keyed coverage floors for the four security-critical paths; global 70 unchanged. |
| `apps/web/e2e/accounts.ts` | Shared Playwright identity, workspace, and invitation fixtures. Not a spec file. |
| `apps/web/e2e/role-denial.spec.ts` | Server-side role denial and 403-vs-404 concealment, asserted through the API with no UI driving. |
| `docs/standards/testing.md` | Delimited Part 75 section: gates, container-specific suites, shared fixtures, denial rules, trace-secret procedure, coverage ratchet. |
| `apps/web/e2e/collaboration-identity.spec.ts` | **Added by the residual-closure session.** The deterministic regression test for the `note-images` flake: holds the member directory back until the editor is live and typed into, then asserts exactly one editor mount and that the typed document reached the row. |
| `apps/web/src/lib/collaboration/note-collaboration-provider.ts` | `setLocalName` publishes the display name into awareness in place; the binding's `user` is a getter so no holder can read a stale name. |
| `apps/web/src/lib/collaboration/useNoteCollaboration.ts` | The display name is read through a ref at construction and is no longer an effect dependency — the root fix. |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Comment only: the latch's "before anyone has typed" claim is corrected to what it actually was, a race. |
| `apps/web/e2e/search.spec.ts` | Both keyboard tests now open the palette through one `openPalette` helper that presses the chord on a poll. |

## Database and Data Changes

None.

## API, Configuration, and Operational Changes

No route, contract, or schema changed. The only configuration change is the widened `env` list on the
`test` and `test:ci` Turbo tasks. That list is also part of the Turbo cache key, which is correct: the
same sources produce different coverage with and without the infrastructure behind them. Existing
`compose.yaml` values already supply everything the new declarations pass through, so no `.env`
change is required for either development or CI.

## Security and Tenant-Isolation Notes

This part adds no production code and therefore no new attack surface. It adds security *assertions*:

- `apps/web/e2e/role-denial.spec.ts` is the first end-to-end proof that same-tenant permission
  failures answer `403` while cross-tenant and guessed identifiers answer `404`. `docs/authorization.md`
  promises that split; collapsing it would be a tenant-existence oracle that every layer below would
  still report as "denied". The spec also asserts the denial body carries no SQL, table name,
  membership fact, or existence detail, and that a refused delete did not delete.
- The per-path coverage floors target exactly the directories where an uncovered branch is a security
  bug: the policy engine, the authentication surface, the tenant scope, and the idempotency guard.
- Backend authorization itself was **not** re-tested here. `apps/api/test/authorization.integration.test.ts`
  and `apps/api/test/tenant-isolation.test.ts` already own the policy engine; duplicating them would
  add maintenance without adding signal.
- The trace-secret procedure recorded below distinguishes fixture credentials (legitimately present,
  per-run, disposable) from deployment secrets (never permissible).

## Verification Evidence

The implementing session was **implement-only** and ran no quality gate. The remediation session ran
them all. Rows are marked with which session produced them.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Pass** | Remediation session. Two errors had to be fixed first: an unused `RequestLike` import and an `import-x/order` violation. |
| `pnpm format:check` | **Pass** | Remediation session. |
| `pnpm type-check` | **Pass** | Remediation session. Three files had to be fixed first, including `apps/web/e2e/accounts.ts:59`, which called `APIResponse.request()` — a method Playwright's `APIResponse` does not have. |
| `pnpm test` | **Pass** | Remediation session. api 2676 passed / 181 skipped, web 1779, shared 448, root scripts 33. |
| `pnpm test:ci` (in the dev API container, `CI=true`) | **Pass** | Remediation session. **235 files passed, 2 skipped, 0 failed**; coverage thresholds met. Baseline before remediation was 230 passed / 5 skipped / **2 failed**. |
| `pnpm build` | **Pass** | Remediation session, with the required HTTPS `NEXT_PUBLIC_*` prefixes. |
| `pnpm e2e:test e2e/role-denial.spec.ts` | **Pass** | Remediation session. 5/5 against the disposable stack — the spec's first real execution. |
| `pnpm e2e:test` (FULL chromium baseline, fresh `e2e:up`) | **Ran — 74 passed / 3 failed / 9 skipped / 4 did not run**, 9.2 min | Earlier session's first baseline. Superseded; see the three-run table below. |
| `pnpm e2e:test e2e/collaboration-identity.spec.ts` (BEFORE the fix) | **Fail — 2 editor mounts** | Residual-closure session. The deterministic reproduction of the `note-images` flake. |
| `pnpm e2e:test e2e/collaboration-identity.spec.ts` (AFTER the fix) | **Pass — 1 editor mount**, 9.1 s | Residual-closure session. |
| `pnpm e2e:test e2e/note-images.spec.ts` x3 isolated, after the fix | **Pass — 18/18**, 1.2 min per run | Residual-closure session. Zero failures under zero contention. |
| `pnpm e2e:test` (FULL baseline, run 1, fresh `e2e:up`) | **79 passed / 1 failed / 9 skipped / 2 did not run**, 9.9 min | Residual-closure session. `note-images` and `print-export` both green; the failure was `search.spec.ts:195`. |
| `pnpm e2e:test e2e/search.spec.ts` (isolated, before the fix) | **Fail — 3 of 3 attempts** | Residual-closure session. Not contention: reproducible alone. |
| `pnpm e2e:test e2e/search.spec.ts` (after the fix) | **Pass — 4/4**, 17.0 s | Residual-closure session. |
| `pnpm e2e:test` (FULL baseline, run 2, fresh `e2e:up`) | **Pass — 82 passed / 0 failed / 9 skipped**, 7.9 min | Residual-closure session. |
| `pnpm e2e:test` (FULL baseline, run 3, fresh `e2e:up`) | **Pass — 82 passed / 0 failed / 9 skipped**, 7.8 min | Residual-closure session. **Two consecutive clean baselines from a clean database — this is the Verify clause.** |
| `pnpm lint` / `pnpm format:check` / `pnpm type-check` / `pnpm test` / `pnpm build` | **Pass** | Residual-closure session, re-run after every change. `pnpm test`: api 209 files passed + 28 skipped (2676 tests), web 155 (1779), shared-validators 16 (398), shared-types 4 (50). `pnpm build` with the HTTPS `NEXT_PUBLIC_*` prefixes. |
| `CI=true pnpm run test:ci` in the dev API container | **Pass — 235 passed / 2 skipped / 0 failed**, exit 0 | Residual-closure session, run **four** times. Three matched the baseline exactly. One intermediate run reported `1 failed | 234 passed | 2 skipped`; its identity was not captured before the log was discarded and it did not reproduce in three subsequent runs. Recorded as an unidentified intermittent rather than as clean. |
| `pnpm e2e:test e2e/task-list.spec.ts` (isolated, after the fix) | **Pass — 8/8** | Was 1 failed + 7 cascade-skipped. |
| `pnpm e2e:test e2e/print-export.spec.ts` (isolated) | **Pass — 1/1, 9.4 s** | Fails only under the full run: contention, not a defect. |
| `pnpm lint` / `pnpm format:check` / `pnpm type-check` / `pnpm test` / `pnpm build` | **Pass** | Re-run 2026-08-26 after the baseline fixes. `pnpm test`: api 209 files passed + 28 skipped, web 155, shared-validators 16, shared-types 4, root scripts 34. |
| `CI=true pnpm run test:ci` in the dev API container | **Pass** | Re-run 2026-08-26. **235 passed / 2 skipped / 0 failed**, identical to the prior run — **no new skip**. Global coverage 87.74 % statements, 79.19 % branches, 89.01 % functions, 90.03 % lines, against the ratcheted thresholds. |
| `CI=true pnpm run test:ci` in the dev API container, run from `/workspace/apps/api` | **Pass — 237 passed / 1 skipped / 0 failed**, exit 0, **three times** | Residual-closure session, 2026-08-26. New baseline: +1 file (`queue-outbox.repository.test.ts`) and +1 suite that had never run (`realtime.integration`). A fourth run failed once and produced the message that named the long-standing intermittent — see Known Limitations. Only `search-reindex.integration` still skips. |
| `npx esbuild <file> --outfile=/dev/null` on all four new TypeScript files | Pass | Syntax/transform check only — not a type check. |
| tRPC internals probe (`node --import tsx`) | Pass | @trpc/server 11.18.0 exposes `_def.inputs` and `_def.output`; `shape.data === createNoteSchema` and `_def.output === noteCreateResultSchema` both hold. |
| Parity dry run (`node --import tsx`, re-implementing the test's assertions outside vitest) | Pass | 39 procedures, 39 map rows, `ALL PARITY ASSERTIONS HOLD`. Strong evidence, **not** a substitute for the reviewer's `pnpm test`. |
| Route and request-shape verification against `docs/openapi.json` | Pass | Every path, method, and body used by `role-denial.spec.ts` was read out of the committed document before being written, including the `{id}` vs `{workspaceId}` workspace-route parameter name and `memberId` meaning `workspace_members.id`. |
| Denial-message leak review | Pass | `authorization-policy.service.ts` emits exactly three safe messages ("Authentication is required.", "The requested resource was not found.", "You are not allowed to do that." / "Confirm your identity to continue."); none contains a forbidden token. |
| Trace-secret grep | **Pass — 0 hits** | **Run 2026-08-26.** Executed against `apps/web/test-results/playwright/note-images-…/trace.zip` (8.2 MB unpacked, a real failed disposable run: `resources/`, `0-trace.trace`, `0-trace.network`, `0-trace.stacks`, `test.trace`). **Zero** files matched for each of the five deployment-secret literals, checked individually as well as together. Fixture-credential hits, expected and acceptable, recorded below. |

### Full chromium baseline — three runs, and it now passes repeatedly

**This is the Plan.md Verify clause for Part 75** — *"the full suite passes repeatedly from a clean
database"*. It is **met**. Each run below is `pnpm e2e:test` immediately after a `pnpm e2e:up` (freshly
reset `notted_e2e_test`), at `workers: 1`, with no other stack running.

| Run | passed | failed | skipped (by design) | did not run | wall | Note |
|---|---|---|---|---|---|---|
| Earlier session, first baseline ever run | 74 | 3 | 9 | 4 | 9.2 min | Found the long-dead `task-list.spec.ts` heading assertion (fixed there). `note-images` + `print-export` failures recorded unattributed. |
| **Run 1**, this session, after the `note-images` fix | 79 | **1** | 9 | 2 | 9.9 min | `note-images.spec.ts` and `print-export.spec.ts:145` **both passed**. The one failure was `search.spec.ts:195`, diagnosed and fixed below. |
| **Run 2**, fresh `e2e:up` | **82** | **0** | 9 | 0 | **7.9 min** | Clean. |
| **Run 3**, fresh `e2e:up` | **82** | **0** | 9 | 0 | **7.8 min** | Clean. |

The passed count rises from 74 to 82 because the three previously-failing tests now pass, four that had
cascade-skipped behind them now run, and this session adds one new spec
(`apps/web/e2e/collaboration-identity.spec.ts`).

#### `note-images.spec.ts` — the flake had a product race behind it, and it is fixed

The earlier record left this **unattributed**, after one hypothesis (a caret stranded on the `doc` node)
was written as a guard, run, and falsified. It is now attributed, and the attribution is backed by a
deterministic experiment rather than by a rate.

**The facts that were already established and that any explanation had to fit:** the failing member
rotated between runs (`:264`, `:387`, `:507`, `:638`, `:731`), each having also passed at least once; the
upload answered **201 in ~46 ms**; the browser then never fetched `…/content`; and the editor rendered
blank **including the paragraph the test had typed before picking any file**.

**The cause.** `NoteEditorSurface` resolves this writer's display name from the workspace member
directory and latches it into `collaborationUser`. That object's `name` was a **dependency of
`useNoteCollaboration`'s effect**, so the latch destroyed the provider, set `mode` back to `"pending"` —
which renders a skeleton *instead of* the editor — and re-handshook onto a fresh `Y.Doc`. Everything
typed since mount that had not yet reached the server died with the old document, and `useImageUploads`'s
recorded caret and insertion controller pointed at an editor that no longer existed.

The comment guarding the latch in `NoteEditorSurface.tsx` claimed the re-handshake "happens while the
directory request is still in flight — **before anyone has typed**". That is a **race, not an
invariant**: it holds only while the directory beats the socket handshake. Losing it is exactly what made
a *different* member fail each run.

This explains every symptom, including the ones the falsified hypothesis could not: the upload really did
succeed (it is a plain HTTP POST already in flight, hence 201 in 46 ms); no `…/content` fetch follows
because no `<img>` node was ever inserted into the live document; the typed paragraph is gone because the
editor holding it was unmounted; and the rotation is simply which test's type-then-pick window happened
to straddle the directory response on the day.

**The experiment, which is the evidence.** `apps/web/e2e/collaboration-identity.spec.ts` takes the race
out of the experiment: it holds the member-directory response back until the editor is up, synced, and
typed into, then counts how many times a ProseMirror root is *created* via a `MutationObserver` installed
in an init script.

| | Result |
|---|---|
| Probe, **before** the fix | **FAIL — 2 editor mounts** (`expect(editorMounts).toBe(1)`, received 2) |
| Probe, **after** the fix | **PASS — 1 editor mount**, 9.1 s |
| `note-images.spec.ts` isolated, after the fix | **18/18 across 3 consecutive runs** (6 tests each, 1.2 min per run) |
| `note-images.spec.ts` under the full suite, after the fix | **passed in all three baselines above** |

**The fix, at the root.** The display name is awareness metadata, not session identity: it never goes on
the wire as identity, it decides no authorization, and the only thing that reads it is the awareness
state peers render as a caret label. `NoteCollaborationProvider.setLocalName` now publishes it in place,
touching neither the document, the epoch, nor the generation; `useNoteCollaboration` reads the name
through a ref at construction and drops it from the effect's dependency list. The binding's `user` became
a **getter** rather than a snapshot so an editor that captured the binding at creation cannot configure
`CollaborationCursor` from an already-stale name.

**No assertion in `note-images.spec.ts` was touched.** No retry, no `sleep`, no widened timeout, nothing
deleted. The spec is byte-identical to what was failing.

#### Two experiments that failed *as experiments*, recorded so nobody repeats them

- **A 10 s hold on the member-directory response never lands.** `DEFAULT_TIMEOUT_MS` in
  `apps/web/src/lib/api/request-json.ts` is **8 s**, and every request runs under an
  `AbortSignal.timeout`, so a longer hold does not delay the response — it cancels it
  (`net::ERR_ABORTED`, no `response` event at all). The probe's hold is capped at 7 s and gated on the
  test's own progress instead of on a wall clock.
- **A `MutationObserver` installed on `document.documentElement` from an init script silently counts
  nothing.** An init script runs before the first byte of the document is parsed, so `documentElement`
  is `null` and `observe` throws — leaving the counter installed and reporting `0`, which reads as a
  passing invariant. Observe `document`. A `childList`-only observer is also blind here: TipTap appends
  the ProseMirror node first and applies `editorProps.attributes` afterwards, so the element is added to
  the DOM before it carries `.notted-editor-content`.

#### `print-export.spec.ts:145` — contention, and it stopped happening

Previously failed in 2 of 3 full runs while passing alone in 9.4 s. It **passed in all three full runs
above**, including run 1 while another spec was still failing. Recorded as contention on a memory-bound
host, which is what the earlier record already suspected; nothing about it was changed.

#### `search.spec.ts:195` — a latent single-press flake, now reproducible, now fixed

Run 1's only failure. It was **not** contention: it failed 3 for 3, including twice alone.

The cause was already written down **in the same file**, three tests up. `:157` presses `Control+K` on a
poll with a comment explaining why — "the document keydown listener is installed by `TopBar`'s effect,
which under load can still be pending, and a chord pressed before then is simply lost — no later timeout
recovers it". `:195` pressed the chord once. The failure snapshot confirms it exactly: the
"Open command menu and search" button is present, and the `Search notes` dialog was never opened at all.

Both call sites now go through one local `openPalette(page)` helper carrying that comment. The repeated
press is not a retry of an assertion — it is the documented way to deliver a chord to a listener
installed asynchronously, and the handler returns early while the palette is open (`if (commandOpen)
return`) so it can never toggle back closed. `search.spec.ts` is **4/4** after the change.

### Coverage ratchet — measured

Read from `coverage/coverage-summary.json` **inside the API container** (`apps/api/coverage` is a
container volume mounted over a read-only bind, so the host copy is stale and must not be used), after
`CI=true pnpm run test:ci` with the full dev stack up.

| Path | statements | branches | functions | lines | floor set |
|---|---|---|---|---|---|
| `src/authorization/**` | 90.37 | 87.65 | 97.56 | 91.47 | **85** |
| `src/auth/**` | 90.34 | **79.05** | 96.94 | 91.54 | **75** |
| `src/tenant/**` | 100 | 100 | 100 | 100 | **95** |
| `src/common/idempotency/**` | 100 | 100 | 100 | 100 | **95** |
| whole project | 87.73 | 79.15 | 89.01 | 90.02 | global stays **70** |

The whole-project row is the run the thresholds were **derived** from. A later re-run measured
87.74 / 79.19 / 89.01 / 90.03 — a different run, not a different number, and the floors are set from
the earlier one.

Each floor is the **lowest of that path's four metrics, rounded down to the nearest 5**, so no metric
can regress unnoticed. Three points are worth stating plainly:

- **`src/auth/**` is the lowest of the four, and that is structural.** Its uncovered branches are the
  live Better Auth flows, which execute only when `AUTH_E2E` and Mailpit are configured. Raise it when
  those suites grow, not by adding shallow unit tests elsewhere in the directory.
- **It could not have met any honest floor before this session.** It measured **63.38 / 49.21 / 73.47 /
  64.48** — below even the 65 placeholder — because `apps/api/test/auth.e2e.test.ts` and
  `advanced-auth.e2e.test.ts` skipped: the dev `api` container set neither `AUTH_E2E` nor a reachable
  Mailpit URL, and those variables existed only on `api-e2e`. Part 75 widened `turbo.json` but never
  closed the compose-side gap. `x-api-environment` now sets `AUTH_E2E`, `MAILPIT_API_URL`,
  `MAILPIT_URL` and `APP_ORIGIN`; all four are read only by files under `apps/api/test/`, so no runtime
  behaviour changed.
- **`src/tenant/**` and `src/common/idempotency/**` are pinned at 95, not 100.** A literal 100 is a
  hair-trigger that turns the next added line into a red build before anyone has written a test for it,
  which trains people to lower the threshold. 95 keeps the signal with one line of slack.

### Trace-secret verification procedure

Run after any failed Playwright run that produced a trace:

```bash
unzip trace.zip -d ./trace-inspect
grep -rlF -e 'notted-development-auth-secret-change-me' -e 'notted_dev_password' \
  -e 'notted-dev-minio-secret' -e 'notted-dev-meili-master-key' \
  -e 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' ./trace-inspect   # expect 0 hits
```

Zero hits is the pass condition.

#### Result — run 2026-08-26

All five literals were first confirmed to still be the live values in `.env.example` and
`apps/api/.env.example` (`POSTGRES_PASSWORD`/`DATABASE_URL`, `MINIO_ROOT_PASSWORD`/`MINIO_SECRET_KEY`,
`MEILI_MASTER_KEY`/`MEILISEARCH_API_KEY`, `BETTER_AUTH_SECRET`, `DATA_ENCRYPTION_KEYS`) — a grep for a
literal that had been rotated out of the examples would pass for the wrong reason.

| Literal | Files matched |
|---|---|
| `notted-development-auth-secret-change-me` | **0** |
| `notted_dev_password` | **0** |
| `notted-dev-minio-secret` | **0** |
| `notted-dev-meili-master-key` | **0** |
| `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` | **0** |

**Pass.** No deployment secret is present in the trace.

The fixture credentials that *are* present, recorded rather than hidden, because the claim below is
about deployment secrets and not about credentials in general:

| Literal | Files matched | Why this is acceptable |
|---|---|---|
| `Fresh1!Password` | 5 | The shared fixture password from `apps/web/e2e/accounts.ts`. It is what the browser typed; a trace of a real login that omitted it would be a trace of nothing. |
| `example.test` | 15 | The per-run `randomUUID()`-suffixed fixture email domain. Identifies nobody. |
| `better-auth.session` | 2 | The session cookie the fixture password produced. Scoped to the disposable database. |

Each of these belongs to an identity created inside `notted_e2e_test` with a `randomUUID()` suffix, and
the next `pnpm e2e:up` drops that database — so the credential is invalid before anyone could read the
trace, and it grants nothing anywhere else.

**Be honest about what this proves.** A trace *does* legitimately contain the fixture password and
the session token it produced — that is what the browser sent, and no trace of a real login could
omit it. The verifiable claim is **"no deployment secret"**, not "no credentials". It is acceptable
because the identity is created per run with a `randomUUID()` suffix inside a disposable database
that the next `pnpm e2e:up` drops. A hit on any literal above means a deployment secret reached the
browser, and the leak — not the trace — is the bug.

## Known Limitations and Follow-up Work

- ~~**RESIDUAL — the full chromium suite does not pass repeatedly on this host.**~~ **Closed.** The
  `note-images.spec.ts` flake was a real product race — the display name was part of the collaborative
  session's identity, so resolving it remounted the editor onto a fresh `Y.Doc` — and it is fixed at the
  root with a deterministic regression test. Two consecutive clean baselines from a fresh database:
  **82 passed / 0 failed / 9 skipped**, 7.9 min and 7.8 min. `print-export.spec.ts:145` passed in all
  three runs and stands as contention. `search.spec.ts:195` surfaced as a separate latent single-press
  flake and is fixed with the pattern its own sibling test already carried.
- **Still not proven on VPS-class hardware.** Two green runs here are evidence of repeatability *on this
  host* — WSL2, 6 logical CPUs, 8.9 GB RAM, shared Docker daemon, `web-e2e` on `next dev`. They are a
  floor, not a certification. The product fix above is hardware-independent; the contention finding for
  `print-export.spec.ts` is not. That spec's persisted-row poll was the tightest in the suite at **20 s**
  while `note-images.spec.ts` gives the identical wait — the Yjs projection landing in `notes.content` —
  **60 s**; it is now 60 s in both, which removes the one asymmetry a re-run on real hardware would
  otherwise have to rule out first.
- **The container coverage run had one unidentified intermittent failure.** Four runs of
  `CI=true pnpm run test:ci` in the dev API container: three at exactly **235 passed / 2 skipped / 0
  failed, exit 0**, and one at `1 failed | 234 passed | 2 skipped`. The failing file's name was not
  captured before the log was discarded, and three subsequent runs did not reproduce it.

  **Closed 2026-08-26 — reproduced, named, and fixed.** The failing file is
  `test/advanced-auth.e2e.test.ts`, and the failure is
  `AssertionError: expected 2591999999 to be 2592000000`. Three session-lifetime assertions compared
  `expiresAt - createdAt` to an exact millisecond count, but Better Auth stamps those two columns
  independently, so the difference lands **1 ms short** whenever the clock ticks between them. It is a
  coin flip, not a load effect — which is why three clean runs in a row never disproved it. The three
  assertions now go through `expectSessionTtl`, a 1 s window; the values they distinguish are 1 day
  against 30 days, so nothing they exist to prove is weakened. Four full container runs after the fix:
  **237 passed / 1 skipped / 0 failed, exit 0**, three times, with the one failure being the run that
  finally produced the message.

  Two load-sensitive budgets were loosened in the same pass, before the real cause surfaced, and are kept
  because they were genuinely too tight: `svg-safety.test.ts` allowed **1 s** for a pure-JS regex scan
  over 20 000 characters — precisely the work v8 coverage instrumentation slows most — and
  `image-processing.service.test.ts` allowed **2 s** for two decompression-bomb rejections; both are now
  **5 s**, which still separates linear from exponential by orders of magnitude. Vitest's `testTimeout`
  was also unset, leaving the **5 s default** below what the slowest legitimate test in the suite needs
  under coverage (the multi-instance realtime distributed-cap case, measured at **26.5 s**); it is now an
  explicit `60_000`.
- ~~**Coverage ratchet is unmeasured.**~~ **Closed** — measured and set; see the table above.
- ~~**The trace-secret grep has never been run.**~~ **Closed** — run 2026-08-26, 0 hits on all five
  deployment-secret literals; fixture-credential hits recorded with their justification.
- **`apps/web/e2e/dashboard-shell.spec.ts` is still a dead spec, and still not deleted.** It requires
  `PLAYWRIGHT_SHELL_EMAIL` / `PLAYWRIGHT_SHELL_PASSWORD`, which nothing sets — the seed writes no Better
  Auth credential accounts, so a seeded user cannot sign in by password. Part 76's specs supersede it
  only **partially**; see that record for the six assertions that have no equivalent anywhere. Its
  disposition remains open.
- ~~**`test/realtime.integration.test.ts` passes.**~~ **It had never run.** Under the documented container
  command the whole in-container `test:ci` invocation dies before any test executes —
  `/workspace` is mounted `read_only: true`, and the root script is `turbo run test:ci`, which needs to
  write a per-package `.turbo/*.log`. Running the **package** script instead
  (`--workdir /workspace/apps/api`) let the suite run for the first time, and it failed all four tests
  with `expected 200 "OK", got 429 "Too Many Requests"` from its own `identity()` helper: it registers at
  least two identities per test against `RATE_LIMIT_AUTH_PER_MINUTE`, whose default is **5**. Every
  sibling e2e suite raises that limit at module scope; this one never did, so it could not have passed on
  any host. Fixed with the same override `advanced-auth.e2e.test.ts` carries, and the corrected command
  is now in `CLAUDE.md` and `docs/README.md`. **The baseline moves from 235 passed / 2 skipped to
  237 passed / 1 skipped** — one new file plus this suite, with only the `search-reindex` index-wiping
  gate still skipped.
- ~~**`apps/api/src/search/hybrid-search.integration.test.ts` is permanently skipped.**~~ **Closed** —
  the gate now reads `MEILISEARCH_HOST` and the suite runs. Documenting a dead gate instead of fixing
  it was the wrong call: a suite that can never run is not a skip, it is an absence.
- **Parity proves schemas, not behaviour.** Authorization, tenant scoping, idempotency, and error
  mapping are equal-or-not for reasons the contract test cannot see. Those are covered by
  `authorization.integration.test.ts`, `tenant-isolation.test.ts`, and the per-resource integration
  suites.
- **No new spec migrations.** Eighteen specs still re-derive `APP_URL`/`API_URL` and their own
  registration helper. Migrate opportunistically, never as a standalone change.
- **The gate guard asserts three variables, not all of them.** `MAILPIT_URL`, `AUTH_E2E`,
  `REALTIME_INTEGRATION`, and `MEILISEARCH_INDEX_PREFIX` select an *optional* suite rather than
  describing the stack, and several only apply inside `api-e2e`, so asserting them would fail a
  correct development run.

### Found by the remediation session, and fixed here

- **`apps/api/test/app.e2e.test.ts` failed whenever `BETTER_AUTH_TRUSTED_ORIGINS` was inherited** — a
  condition that Part 75's own `turbo.json` change created. The second `describe.sequential` overrode
  `APP_URL` without pinning the trusted-origin list, so boot aborted with
  `BETTER_AUTH_TRUSTED_ORIGINS must include APP_URL` and cascaded into a `Cannot read properties of
  undefined (reading 'close')` in `afterAll`. The file's own header documents the hazard for the *first*
  block; the second never got the same treatment. It does now.
- **`apps/api/test/storage-maintenance.integration.test.ts` asserted a pristine database.** Its live
  system-scope sweep asserted zero mutations across the whole database. Three of its four sweeps are
  bounded by retention windows the test pushes past a century, but `expiredExports` is selected on each
  row's own `object_expires_at` and no window widens or narrows it — so a long-lived development database
  legitimately has expired exports swept. Measured on this host: **132 rows marked, 66 objects removed**,
  all of them expired exports from earlier work. The assertion is now per-sweep, with `expiredExports`
  excluded and the reason stated in the file. The test **passes repeatedly** on both the development
  database and a freshly reset `e2e` one, which is the criterion Plan Part 75 asks for.
- **`apps/api/test/advanced-auth.e2e.test.ts` was rate-limited the moment it started running.** Two
  tiers had to be raised at module scope, the way `auth.e2e.test.ts` already does: the per-IP
  authentication budget (`RATE_LIMIT_AUTH_PER_MINUTE`, default 5) and the sensitive tier that governs
  `/two-factor/*` (`RATE_LIMIT_SENSITIVE_PER_MINUTE`, default 10). The latter matters more than it
  looks: Better Auth keeps that counter in `secondary-storage` — Redis — keyed by IP and path, so it is
  shared with every other suite in the run **and** with the long-lived API container on the same stack.
  The limit is read from the requesting process's own config, which is what makes a module-scope
  override sufficient.

## Handoff Notes

- **`turbo.json` is owned by this part in this session.** Part 78 should not need to touch it.
- **`docs/standards/testing.md` uses HTML delimiters** (`<!-- BEGIN Part 75 ... -->` /
  `<!-- END Part 75 -->`). Parts 76 and 78 append their own sections *below* the END marker so the
  edits merge cleanly.
- **`apps/web/e2e/accounts.ts` is not a spec file and must stay that way.** Renaming it to
  `*.spec.ts` would make Playwright collect it as a zero-test file.
- **Adding an API suite that reads a new environment variable means editing `turbo.json` in the same
  change**, or the suite will skip in CI and nothing will say so.
- **`apps/api/vitest.config.ts` keeps `fileParallelism: !hasDatabase` and `clean: false`** for the
  reasons in their comments (seed-row deadlocks; an EROFS mount point in the dev container). Neither
  was changed here and neither should be changed without reading those comments.
- **The parity map is a maintenance surface by design.** A new tRPC procedure fails
  `trpc-rest-parity.contract.test.ts` until it is classified. That is the point: it is the same
  bidirectional-inventory trick `openapi.contract.test.ts` uses for REST routes.
- **The role-denial spec is `test.describe.serial`** with a single `beforeAll` that provisions five
  browser contexts. If it becomes slow, the fix is fewer identities, not `fullyParallel` — the
  one-worker limit in `playwright.config.ts` is a standing invariant on this host.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-26 | Claude Code implementation session | Initial record. Implement-only; no quality gate run. |
| 2026-08-26 | Review-remediation session `3fb3cda0` | Ran every gate. Fixed the lint and type-check failures, closed the compose-side `AUTH_E2E`/Mailpit gap that kept `src/auth/**` unmeasurable, set all four coverage floors from measurement, fixed `hybrid-search.integration.test.ts`'s dead gate, fixed `app.e2e.test.ts`'s inherited-origin failure, scoped `storage-maintenance.integration.test.ts` off a pristine-database assumption, raised the two rate-limit tiers `advanced-auth.e2e.test.ts` needs, and ran `role-denial.spec.ts` green. **State → Complete.** |
| 2026-08-26 | Residual-closure session `3fb3cda0` | Closed the `note-images.spec.ts` residual by **finding the product race behind it**: the collaborative session was rebuilt whenever the member directory resolved this writer's display name, unmounting the editor and discarding the live `Y.Doc`. Proved it with a deterministic probe (`collaboration-identity.spec.ts`: 2 editor mounts before, 1 after), fixed it at the root in `note-collaboration-provider.ts` / `useNoteCollaboration.ts`, and touched no assertion in `note-images.spec.ts`. Found and fixed a second, unrelated latent flake in `search.spec.ts:195` (single `Control+K` press before `TopBar`'s keydown listener exists — reproducible 3 for 3 alone). Ran **three** full baselines: 79/1, then **82/0** twice from a clean database, settling the "passes repeatedly" half of the Verify clause. **State stays Complete, and the Verify clause is now met in both halves.** |
| 2026-08-26 | Review-remediation session `3fb3cda0` (second pass) | Ran the **trace-secret grep** (0 hits, recorded with the fixture-credential hits). Ran the **first full chromium baseline** on a fresh `e2e:up` before any benchmark: 74/3/9/4. Found and fixed a real defect — `task-list.spec.ts`'s exact heading list had been red since Part 69's `Suggested tags` heading landed, and no full baseline had been run in between; that spec is now 8/8. Recorded the remaining `note-images` / `print-export` failures as measured-and-unattributed after re-running each alone, testing one hypothesis and falsifying it, and reverting the guard rather than keeping a wrong explanation. Re-ran all five gates plus the container coverage run (235 passed / 2 skipped, no new skip). |
| 2026-08-26 | Residual-closure session `3fb3cda0` | **Named and fixed the coverage-run intermittent**: `advanced-auth.e2e.test.ts` compared two independently-stamped session timestamps for exact millisecond equality (`expected 2591999999 to be 2592000000`); the three assertions now use a 1 s window. **Found that `test/realtime.integration.test.ts` had never executed** — the documented in-container `test:ci` fails on the read-only `/workspace` before any test runs, and once run the suite failed all four tests on `RATE_LIMIT_AUTH_PER_MINUTE=5`, an override every sibling e2e suite already carried. New container baseline **237 passed / 1 skipped**, exit 0, reproduced three times. Also raised two wall-clock budgets and set `testTimeout: 60_000`, and corrected the container command in `CLAUDE.md` / `docs/README.md`. |
