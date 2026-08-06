# Part 39 — Implement reliable save behavior

## Status

- **State:** Complete with follow-up
- **Completed on:** 2026-08-06
- **Implemented by:** frontend-editor-engineer agent (implementation only; gates run separately)
- **Plan reference:** `Plan.md`, Part 39
- **Related records:** `part-33-tiptap-document-contract.md`, `part-34-basic-editor-toolbar.md`, `part-37-page-container.md`, `part-38-page-breaks-focus-print.md`, `part-31-core-note-apis.md`, ADR 0004

## Objective

Give the note editor an autosave that cannot lose acknowledged content and cannot overwrite a newer server version. The Plan asks for a debounced state machine with dirty/saving/saved/error/conflict/offline states, version preconditions on every write, safe retries for transient failures, a navigation flush, a distinction between document-content updates and settings updates, and explicit retry/reload/conflict-resolution UI.

Scope for this part is **document content plus the page-size setting**. Inline title editing is deliberately not added to the note detail page: titles are edited from the note list (`RenameNoteControl`), and "distinguish content from settings" is satisfied here by content saves versus the Part 37 page-size toggle.

## Implemented Work

- A pure, framework-free state machine (`lib/notes/autosave-machine.ts`). Events in, `{ state, effects }` out. No React, no timers, no `fetch`. States: `idle | dirty | saving | saved | retrying | error | conflict | offline`.
- **One version cell, one in-flight request, one coalesced patch.** A pending document change and a pending page-size change are always merged into a single `PATCH` carrying a single `expectedVersion`.
- **Debounced typing** (800 ms) collapsed into one request. The dirty check uses `areDocumentsEquivalent` from `components/editor/document-sync`, so a document edited back to the saved value produces no request at all, and key-order differences between the contract and ProseMirror are not mistaken for edits.
- **A baseline event.** The editor reports its own serialization of the document it opened with (`onEditorReady` → `safeParseNoteDocument(editor.getJSON())`). Without it, ProseMirror's default attributes make the loaded note look different from the stored note, and merely opening a note issues a write. The baseline is accepted only before anything has been queued or sent, so it can never impersonate an acknowledgement.
- **Out-of-order safety.** Every save carries a monotonic `saveId`; a result whose id is not the current in-flight one is discarded outright. A stale success cannot regress the version, cannot replace newer acknowledged content, and a stale failure cannot halt the machine.
- **Retries.** Only `unavailable` failures the request layer marks retryable are repeated: 429, 5xx, network faults, and timeouts. Backoff is 1s/2s/4s/8s, capped at 30s, bounded to 4 attempts, and a `Retry-After` header wins when present. `invalid`, `forbidden-or-not-found`, `conflict`, and non-retryable `unavailable` are terminal.
- **Conflicts halt.** On `version-conflict` the machine stops. More typing, timers, manual retry, a settings press, a flush, and reconnecting all leave it stopped. The only offered resolution is "Reload latest version" (`router.refresh()`), whose copy says plainly that reloading discards the local changes. The pending work is kept in memory so nothing is destroyed before the user chooses.
- **Offline.** `navigator.onLine` plus `online`/`offline` events. Work is queued in memory and resumes on reconnect. No browser-storage draft of any kind.
- **Navigation flush.** `visibilitychange → hidden` flushes immediately with `keepalive`. Component unmount (an in-app route change, which fires neither `beforeunload` nor `visibilitychange`) flushes the queued patch fire-and-forget. `beforeunload` sets `returnValue` while anything is unacknowledged so the browser shows its native leave prompt.
- **Request layer.** `updateNote` accepts `{ keepalive }`; failures may now carry `retryable` and `retryAfterMs`. `Retry-After` is parsed as delta-seconds or an HTTP date and clamped to 300s.
- **UI.** `SaveStatusIndicator` renders an inline `role="status" aria-live="polite" aria-atomic` region with plain-language copy for every state, an explicit "Retry saving" button where a retry can help, and "Reload latest version" on a conflict. A contract rejection from the editor raises its own separate `role="alert"`. All copy is written on the client from the failure kind; no backend message is displayed verbatim.
- **One rejection, one assertive announcement.** `SaveStatusIndicator` owns the contract-rejection alert on the note page, because it is the message that states the consequence — nothing saves until the change is undone. `TiptapEditor` renders its own alert only when no `onDocumentRejected` host is listening, so a standalone editor still reports the rejection and the hosted page never queues two overlapping assertive messages for one event.
- `TiptapEditor` gained `onDocumentRejected`. It still performs zero network I/O.
- **`NoteDetailView` no longer renders `version {note.version}`.** The header is server-rendered and this part bumps `version` on every keystroke burst, so the number was wrong within a second of typing — the same reason the page-size badge had already moved into `PageContainer`. Live save state is `SaveStatusIndicator`'s job.

## Important Decisions

- **One version cell and coalesced patches are not optional.** `apps/api/src/notes/notes.service.ts` bumps `version` by exactly one on every update, including a page-size-only change. Two independent mutations would each invalidate the other's `expectedVersion` on nearly every interleaving, producing constant false conflicts. Hence: one machine, one version cell, one request in flight, content and settings merged into one PATCH.
- **A page-size press is not debounced; typing is.** A discrete control press is an explicit act, so it flushes immediately and carries any pending text with it. This also preserves Part 37's observable behaviour (press → request).
- **Settings roll back on a terminal failure; content never does.** A toggle shows a definite state and must not keep claiming a change that definitively did not happen, so the pending page size is dropped and the control reverts. The document is always kept queued: rolling text back would be data loss. This is the concrete meaning of "distinguish document-content updates from settings changes" in this part.
- **The page-size buttons are no longer gated while a save is open.** A press during a save is coalesced into the next patch rather than refused, which also removes an `aria-disabled` state that could strand a focused control.
- **No browser-storage drafts.** Part 32 established that no note content is written to `localStorage` or IndexedDB, and Part 37/38's `page-preferences.ts` stores only UI numbers. The offline queue is in memory only, and the offline copy states outright that closing the tab loses the changes. Persisting note content to the browser would create an unencrypted, unscoped copy of tenant data outside every backend policy — a worse failure than an honest warning.
- **`keepalive`, not `navigator.sendBeacon`.** The API's `assertTrustedMutationOrigin` requires a trusted `Origin`, and the endpoint requires `Content-Type: application/json` and the session cookie. `sendBeacon` cannot set a JSON content type without switching to a `Blob` and gives no control over credentials, so it was rejected. **What was verified:** `requests.test.ts` asserts that a flush sends `keepalive: true`, `credentials: "include"`, `Content-Type: application/json`, and **no** `AbortSignal` — the hardcoded `AbortSignal.timeout(8_000)` is dropped for keepalive because a timer scheduled on a page that is going away either never fires or cancels the very request the flush exists to deliver. **What could not be verified here:** jsdom does not send real requests, so the `Origin` header, and whether the browser actually completes the request after the document is discarded, are only verifiable in a real browser (see Known Limitations). The fetch specification rejects a keepalive body over 64 KiB outright, so bodies above `KEEPALIVE_BODY_LIMIT_BYTES` fall back to an ordinary request rather than silently failing; that fallback is tested.
- **`NoteRequestFailureKind` was not widened.** The union is consumed by roughly eight components. `retryable` and `retryAfterMs` were added as optional fields on the failure result instead, so existing consumers are untouched.
- **A React context, not a module store.** Unlike focus mode (Part 38), both ends of this handle genuinely live under one client parent (`PageContainer`), so the handle is per-note rather than per-tab. Absent a provider every method is a safe no-op.
- **This autosave is interim.** Per ADR 0004, Yjs becomes the collaborative source of truth in Part 58, at which point conflict semantics change: CRDT merge replaces "halt and ask the human". Part 58 must define which path owns writes so autosave and CRDT updates cannot race. `apps/api/src/database/schema/notes.ts` previously attributed Yjs binary persistence to "Part 39" in two comments; both were corrected to Part 58 here. Comment-only change — no Yjs work is in this part.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/web/src/lib/notes/autosave-machine.ts` | New. The pure state machine: states, events, effects, backoff, dirty detection, coalescing, out-of-order guard, and all user-facing copy selectors. |
| `apps/web/src/lib/notes/autosave-machine.test.ts` | New. The whole Plan verify list without a DOM. |
| `apps/web/src/components/notes/useNoteAutosave.ts` | New. React/timer/network/event adapter: debounce and backoff timers, `updateNote`, `online`/`offline`, `visibilitychange`, `beforeunload`, unmount flush, re-seed on a newer server render. |
| `apps/web/src/components/notes/use-note-autosave.test.tsx` | New. Timing, listener lifecycle, flush, leave prompt, permission gate. |
| `apps/web/src/components/notes/note-save-context.tsx` | New. Carries the save handle from `PageContainer` to the editor, which arrives as opaque `children`. No-ops without a provider. |
| `apps/web/src/components/notes/SaveStatusIndicator.tsx` | New. Inline polite status plus Retry/Reload affordances and the contract-rejection alert. |
| `apps/web/src/components/notes/save-status-indicator.test.tsx` | New. Semantics, affordances, keyboard operability. |
| `apps/web/src/components/notes/note-autosave-integration.test.tsx` | New. Drives the real TipTap editor through `PageContainer` → machine → `updateNote`, and exercises the `onDocumentRejected` seam. |
| `apps/web/src/lib/notes/requests.ts` | `updateNote` accepts `{ keepalive }`; failures carry optional `retryable`/`retryAfterMs`; `Retry-After` parsing; 64 KiB keepalive guard. |
| `apps/web/src/lib/notes/requests.test.ts` | Retryability per status, `Retry-After` parsing, keepalive request shape and fallback. |
| `apps/web/src/components/editor/TiptapEditor.tsx` | Added `onDocumentRejected`. Supplying it also transfers ownership of the rejection `role="alert"` to the host, so one rejection produces one assertive announcement. Still performs no network I/O. |
| `apps/web/src/components/notes/NoteDetailView.tsx` | Dropped the server-rendered `version {note.version}` from the header, which this part makes stale on every keystroke burst. |
| `apps/api/src/database/schema/notes.ts` | Comment-only: two stale "Part 39" attributions for Yjs binary persistence corrected to Part 58 (ADR 0004). |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Consumes the save context; forwards `onDocumentChange`/`onDocumentRejected`; publishes the editor's baseline document. |
| `apps/web/src/components/notes/PageContainer.tsx` | Owns the machine, provides the save context, renders `SaveStatusIndicator`; `persistPageSize` is now the machine's settings queue. Layout announcements moved to their own region. |
| `apps/web/src/components/notes/page-container.test.tsx` | Adapted to the machine: request shape, retry/exhaustion, conflict and denial copy, queued presses. |

## Database and Data Changes

None. No schema, migration, seed, or retention change. The only persisted effect is the existing `PATCH /api/v1/workspaces/:id/notes/:id`.

## API, Configuration, and Operational Changes

No new routes, environment variables, ports, or flags. No new npm dependency (ADR 0008's matrix is unchanged). The client now sends `keepalive` on flush requests and reads the `Retry-After` response header, which `apps/api/src/main.ts` already exposes through CORS (`exposedHeaders`). Defaults are safe for development and production; the debounce, attempt bound, and backoff cap are module constants.

## Security and Tenant-Isolation Notes

- No new trust boundary. Every write still goes through `updateNote`, which re-validates against `updateNoteSchema` client-side and is authorized server-side by the existing note policies. `contentPlain` remains server-derived and is never sent.
- `canUpdate` gates the client from issuing writes it knows will be refused; backend policy remains authoritative and is not weakened.
- The workspace and note identifiers passed to the machine are the ones the server rendered for this note; they are never derived from user input.
- No note content is written to browser storage, so an offline queue cannot leave tenant data at rest in the browser.
- Failure copy is written entirely on the client from the failure kind; no backend message, code, or request id is rendered.
- The keepalive flush is a normal credentialed fetch, so `assertTrustedMutationOrigin` still applies; `sendBeacon`, which would not satisfy it, is deliberately unused.

## Verification Evidence

This part's stated verify criterion — `tests simulate rapid typing, slow responses, out-of-order responses, network loss, tab close, and version conflicts without losing acknowledged content` — needs no browser and is met: Review #2 confirmed all six scenarios are explicitly covered in `autosave-machine.test.ts` and `use-note-autosave.test.tsx`. The listed follow-ups (real-browser keepalive confirmation, PATCH idempotency, the in-flight-navigation window) are non-blocking and recorded under Known Limitations.

| Check | Result | Notes |
|---|---|---|
| `pnpm format:check` | Pass | Clean across all 4 workspace tasks and the root Prettier pass. |
| `pnpm lint` | Pass | 4/4 tasks at `--max-warnings 0`. |
| `pnpm type-check` | Pass | 6/6 tasks. |
| `pnpm test` (`DATABASE_URL` exported) | Pass | 6/6 tasks: web 77 files, api 61 passed + 2 skipped, shared-validators 9, shared-types 2, plus 11 root `node --test` script tests. |
| `pnpm test:ci` (`DATABASE_URL` exported, `--force`) | Pass | 6/6 uncached. Coverage — web 81.28/74.68/84.87/83.36, api 79.26/72.44/83.68/81.12, shared-validators 84.26/78.48/95.76/87.33, shared-types 100. All above the 70% thresholds. |
| `pnpm build` (production-like `NEXT_PUBLIC_*`) | Pass | 4/4 tasks; compiled and generated 16/16 static pages. |
| `pnpm --filter @notted/web exec playwright test --project=chromium` | **Not run — could not run** | Chromium cannot launch in this environment: `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, `libasound.so.2` are missing and installing them needs `sudo`. Recorded as an unverified limitation, never as a pass. |

## Known Limitations and Follow-up Work

- **The keepalive flush is unverified in a real browser.** jsdom proves the request *shape* only. A Playwright check should confirm that hiding or closing the tab with unsaved text results in a stored note, and that a >64 KiB note falls back correctly. Target: Part 39 follow-up or the next Playwright pass.
- **No Playwright journey was added** for autosave, offline, or conflict resolution. The verify list is fully covered in jsdom, but network loss and tab close are browser behaviours worth an end-to-end check.
- **An in-app navigation flush is fire-and-forget, and unreportable by construction.** `useNoteAutosave.ts`'s unmount teardown calls `void updateNote(...)` with no `.then` and no reporting: the component that would have shown the answer is already gone, so a failed flush is silently lost. `beforeunload` covers the full-page case with a prompt, but a client-side route change fires neither `beforeunload` nor `visibilitychange` and has no equivalent guard. This cannot be fixed inside Part 39's scope. The remedy is out of scope and structural: a durable queue outside the component tree — a service worker or a `localStorage`/IndexedDB outbox with a background sync — which would also have to reckon with the "no note content in browser storage" rule established in Part 32. A router-level "unsaved changes" interception is the cheaper partial mitigation.
- **A large flush is very likely to be aborted.** `requests.ts`'s `bodyFitsKeepalive` drops `keepalive` when the serialized body exceeds `KEEPALIVE_BODY_LIMIT_BYTES` (64 KiB, the fetch specification's limit), because the specification rejects such a request outright. The fallback path then re-attaches `AbortSignal.timeout(8_000)` — on a page that is going away. So for a note over 64 KiB the unmount/hidden flush is an ordinary, abortable request racing document teardown and will usually not complete. Same remedy as above: a durable queue is the only reliable answer.
- **Text typed while a save is in flight is dropped by an in-app navigation.** The unmount flush goes through `canSaveNow`, which requires `inFlight === null`, so the sequence "save A on the wire → keep typing (pending B) → click an in-app link" sends A and discards B, with no `beforeunload` prompt because client-side routing does not fire one. The Plan's stated invariant — never lose *acknowledged* content — still holds, since B was never acknowledged; this is a reliability gap, not an acceptance-criterion violation. **A naive re-send is unsafe and was deliberately not implemented:** the in-flight save A will bump `version`, so a second write issued under the same pre-flight `expectedVersion` would 409 as a spurious `VERSION_CONFLICT`. Any real fix has to wait for A's acknowledgement to learn the new version. That is not, however, impossible after unmount: `performSave`'s `await updateNote(...)` continuation does keep running — only `dispatch` is short-circuited by `mountedRef` — so a follow-up write issued from the request continuation, using the version the server just returned, would close this window without a durable queue. It was deliberately left undone here because it puts a network write outside the React lifecycle with no component left to report failure to, and Review #2 judged the documented limitation acceptable for this part. (An earlier revision of this record called the fix impossible; corrected after Review #2.) The current behaviour is pinned by an explicitly named characterization test: `use-note-autosave.test.tsx` → "characterizes a known limitation: drops a patch queued behind an in-flight save on unmount".
- **A retried PATCH whose first response was lost produces a spurious conflict.** Review #2 finding M-2. `requests.ts` marks every network fault `retryable`, so if the server committed but the response never arrived, the retry carries a now-stale `expectedVersion`, the API answers 409, and the machine halts in `conflict` showing copy that says reloading "discards the changes you made here" — when in fact they were saved. Note *creation* already requires an `Idempotency-Key` (`notes.controller.ts`); the note PATCH does not, which is also what `CLAUDE.md` asks for on retryable side-effecting mutations. Two candidate remedies: accept an `Idempotency-Key` on the PATCH (backend, and the better fix), or on `version-conflict` re-read the note once and adopt the new version silently when the server document already equals the pending one. Both are outside Part 39's frontend scope; the backend option belongs with Part 65's public-API work.
- **Conflict resolution is reload-only.** There is no merge or diff view. Content-level reconciliation is ADR 0004's job in Part 58 (Yjs), which will also decide which path owns writes so autosave and CRDT updates cannot race.
- **The editor emits one transaction on mount** in the `NoteEditorSurface` tree (not in the bare `TiptapEditor`), which the baseline event absorbs. The underlying cause was not chased down; it is worth identifying, because it also implies an avoidable ProseMirror `setContent` or plugin transaction at open time.
- **Title and other note settings are not wired** to the machine yet. When title editing moves onto the detail page, it must join this machine's queue rather than issuing its own `updateNote` — otherwise it will fight the same `expectedVersion`.
- **Chromium could not be launched in this environment**, so no Playwright verification of any kind was possible during the fix pass: `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, and `libasound.so.2` are missing and installing them requires `sudo`. Every browser-dependent criterion above therefore remains unverified and is escalated rather than assumed.

## Handoff Notes

- **The single-version-cell rule is load-bearing.** Any new note mutation reachable from the note detail page must go through `useNoteAutosave`, not call `updateNote` directly. The API bumps `version` on every update, so a second writer will produce spurious `VERSION_CONFLICT`s for the first.
- **Keep the machine pure.** `lib/notes/autosave-machine.ts` must stay free of React, timers, and `fetch`; that is what makes the whole Plan verify list testable without a DOM. New behaviour belongs in the reducer with a new effect kind, and the hook translates it.
- It imports `areDocumentsEquivalent` from `components/editor/document-sync` — a deliberate, pure, DOM-free reuse so the dirty check and the editor's reconciliation can never disagree about what "the same document" means. Do not fork it.
- **`document-baseline` matters.** Removing it makes opening a note write to it, because ProseMirror fills in default attributes the stored contract omits. It is accepted only while `savedDocument === null && inFlight === null && lastSaveId === 0`.
- **The out-of-order guard is the `saveId` check** at the top of `save-succeeded`/`save-failed`. Never adopt a result without it.
- **Testing.** MSW is not installed; mock `@/lib/notes/requests` with the `vi.hoisted` idiom. `vi.clearAllMocks()` does *not* drop queued `mockResolvedValueOnce` values, so `page-container.test.tsx` and the new suites call `mocks.updateNote.mockReset()` in `beforeEach` — an unconsumed queued value otherwise answers the next test's first request. Suites that install fake timers do so in `beforeEach`/`afterEach`, never inside a test body: a test that times out with fake timers installed leaves them installed for every suite that follows.
- **`PageContainer` now has two live regions**: `note-layout-status` (zoom, margins, focus mode, acknowledged page size) and `note-save-status` (save state). They are separate so a zoom change cannot overwrite "Couldn't save".
- **Part 58 (Yjs) will change conflict semantics here.** Read ADR 0004 before altering the conflict path.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-06 | frontend-editor-engineer agent | Initial record (implementation complete; repository gates not yet run) |
| 2026-08-06 | frontend-editor-engineer agent (Review #1 fix pass) | Gave the contract-rejection alert a single owner (`SaveStatusIndicator` when a host listens, `TiptapEditor` only standalone); removed the stale server-rendered `version` from `NoteDetailView`; corrected the stale Yjs "Part 39" comments in the API notes schema to Part 58; added a named characterization test for the in-flight-save unmount drop and documented it, the fire-and-forget flush, and the >64 KiB keepalive fallback under Known Limitations; recorded the gates actually run, including `pnpm test:ci` passing with `DATABASE_URL`. |
