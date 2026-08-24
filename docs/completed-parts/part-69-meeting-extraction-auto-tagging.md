# Part 69 — Implement meeting extraction and auto-tagging

## Status

- **State:** Complete — two review rounds passed; full quality gate green on 2026-08-25
- **Completed on:** 2026-08-25
- **Implemented by:** Claude Code session (lead part engineer + three specialist agents)
- **Plan reference:** `Plan.md`, Part 69
- **Related records:** [Part 68](part-68-summarize-continue-tone.md) (provider stream consumption, prompt table, AI panel, the never-mutate-before-accept rule), [Part 67](part-67-ai-configuration-governance.md) (provider seam, governance gate, usage metering), [Part 58](part-58-yjs-collaborative-editing.md) (who owns `notes.content`), [Part 46](part-46-tags-and-templates.md) (note tag assignment), [Part 47](part-47-standalone-tasks.md) (task creation)

## Objective

Turn two kinds of unstructured text into reviewable structure: a pasted meeting transcript into attendees, agenda, discussion points, decisions and action items; and a note's own content into tag suggestions. The governing requirements from `Plan.md` are that **malformed model output is repaired or rejected safely**, that **duplicate tasks and tags are prevented**, and that **no content is changed without confirmation** — which here means no note write, no task, and no tag assignment happens before an explicit Insert or Apply.

## Implemented Work

- **Structured-output validation with one repair pass** (`apps/api/src/ai/json-repair.ts`): strip markdown fences → `JSON.parse` → `safeParse`. On failure the caller's `repair` callback is invoked **exactly once** with a short zod-derived issue string and the rejected output, and the result is re-parsed. A second failure is a `422 AI_OUTPUT_INVALID`. The helper itself makes **no provider call** — that is what keeps "at most two provider calls" a property of the code rather than of a comment. The issue string is built from zod issues only, never from raw model text, because it is fed straight back into a prompt.
- **Non-streaming completion** (`AiStreamService.complete()`): the same prologue as Part 68's `run()` — authorize (`note.read`, only when a `noteId` is supplied) → governance `acquire()` → resolve provider → consume the provider stream, aggregating deltas and taking the last `usage` event — and the same `finally` writing **exactly one `ai_usage` row**. It reuses `run()`'s own `outcome()` helper, so metering semantics are literally the same code rather than a parallel implementation. This is the seam Part 70's grammar service consumes.
- **Two prompts, versioned** (`ai-prompts.ts`): `meeting_extraction.v1` and `auto_tag.v1`. The shared guardrail sentences were factored into a delimiter-parameterised `sharedGuardrails(tag)` so the JSON features can carry a *JSON-only* output rule where the streaming features carry the plain-text one — the existing `AI_PROMPT_GUARDRAILS` export is reassembled byte-identically from the same pieces, because `ai-prompts.test.ts` asserts it verbatim. `buildJsonRepairPrompt` inherits the base plan's feature, version and budgets and appends one `user` turn quoting the rejected reply inside stripped `<invalid_output>` delimiters.
- **Server-side tag partitioning** (`meeting-extraction.service.ts`): the model is asked only for names and is **never shown a tag id**. The service reads the workspace's own tag pool, matches case-insensitively, and emits `existing` entries carrying the pool's real id and the pool's own spelling; everything unmatched becomes `proposed` after `tagNameSchema`, deduped both ways and capped 10/5. "Only authorized existing tags" is therefore enforced by the partition, not by the prompt.
- **Two JSON REST routes** (`POST …/ai/meeting-extraction`, `POST …/ai/tag-suggestions`): `ai.use`, `sensitive` tier, trusted-origin checked, body-validated with shared schemas, documented in `OPENAPI_ROUTES`, with `docs/openapi.json` regenerated. Neither persists anything.
- **Caller cancellation and per-call timeouts** in the shared HTTP client: `ApiRequestOptions` gained `timeoutMs` and `signal`, merged with `AbortSignal.any`. The house 8 s default would have reported a working 100 000-character extraction as a network fault; extraction gets 120 s and tag suggestion 30 s.
- **Meeting extraction dialog** (`MeetingExtractionDialog.tsx`): transcript step with a live counter, then a review step in the same dialog — five sections, every item checked by default and inline-editable, action items additionally offering an **off-by-default** "Also create a task" plus an "Already exists" badge computed from one bounded page of existing workspace tasks (normalised title compare). Insert builds ProseMirror **JSON nodes** (headings, `bulletList`, and `taskList`/`taskItem`) and inserts at a collapsed position; opted-in tasks are then created sequentially, and a per-task failure is surfaced without rolling back the insert.
- **Tag suggestions** (`TagSuggestions.tsx`): "Suggest tags" sends the live editor text, and results render as two structurally separate groups — existing tags, and "New tags (will be created)" marked with a dashed border *and* an sr-only label so the distinction is never conveyed by border or colour alone. Apply creates confirmed new tags (409 → look up and reuse the existing id), then unions with the note's current `tagIds`.
- **Two entry points** for extraction: a launcher button in the AI panel and a `/meeting-extraction` slash command, both reaching the dialog through a one-slot module store cloned from Part 68's `continue-request.ts`.

## Important Decisions

- **`TagSuggestions` mounts in `NoteEditorSurface`, not beside the note list's tag picker.** The only existing note-tag picker lives in `NoteBrowser` — the note *list* — which has no editor instance, and the suggestion source is required to be the document as the author currently sees it. Part 58 hands `notes.content` to the Yjs projection while a session is live, so the stored row can legitimately be behind what is on screen. Mounting beside the editor is the only place both facts hold.
- **Apply re-reads the note immediately before writing.** Part 39 autosave bumps `notes.version` continuously while the author types, so any version captured when the suggestions rendered would lose the `expectedVersion` CAS by the time Apply is pressed. `requestNoteDetail` is a new client function for exactly this; reading immediately before the write is what makes Apply survive an actively edited note.
- **The model-output schema is deliberately *not* `.strict()`**, unlike every request schema in the file. A model that answers correctly and adds one extra key is not worth a second billed provider call; zod strips unknown keys, so leniency here discards the extra field rather than trusting it. Every list defaults to `[]` and `null`/`""` are preprocessed to `undefined`, because a meeting with no decisions is the common case and a model expresses it by omitting the key.
- **Every list is capped in the contract, not in the renderer.** A model asked for "the action items" can return four hundred, and each becomes a checkbox a human is expected to review. A review screen nobody can finish reading is not a safeguard.
- **The tag pool is read directly off the `tags` table** with an explicit `eq(tags.workspaceId, …)`, rather than importing `TagsModule`. A module edge for one two-column read is not worth the graph coupling, and pinning `workspace_id` explicitly is the same guarantee by the route `ai-governance.service.ts` already uses.
- **A failed task creation does not roll back the note insert.** The inserted content is already the author's, and undoing their editor transaction would be a worse outcome than an unmade task.
- **Closing the dialog keeps the transcript.** Nothing is written without Insert, so discarding a pasted transcript on a stray Escape would be the only destructive act the dialog is capable of.
- **`assignee` stays free text.** Resolving "Sam" to a `UserId` would be a model guessing, from a transcript, who is accountable for something — an inference that must stay a human's to make.
- **Naming deviation (continued from Parts 67/68):** `Notted.md` names no frontend AI components; `src/components/ai/` and `src/lib/ai/` remain a deliberate, recorded deviation on the Part 58 precedent.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/ai.ts` | Meeting/tag-suggestion types, list caps, and the two new `AI_API_PATHS` entries |
| `packages/shared-types/src/api.ts` | `AI_OUTPUT_INVALID` (422) and `AI_PROVIDER_ERROR` (502) added to `ApiErrorCode` |
| `packages/shared-validators/src/ai.schema.ts` | Request schemas, the lenient model-output schemas, and the strict result schemas |
| `apps/api/src/ai/json-repair.ts` | Fence stripping, parse, one repair pass, then 422 |
| `apps/api/src/ai/meeting-extraction.service.ts` | Both features; the server-side tag partition |
| `apps/api/src/ai/ai-stream.service.ts` | `complete()` — the non-streaming seam Part 70 consumes |
| `apps/api/src/ai/ai-prompts.ts` | `meeting_extraction.v1`, `auto_tag.v1`, `buildJsonRepairPrompt`, factored guardrails |
| `apps/api/src/ai/ai.controller.ts` | The two JSON routes |
| `apps/api/src/openapi/openapi.routes.ts`, `docs/openapi.json` | Route documentation, regenerated |
| `apps/web/src/lib/api/request-json.ts` | `timeoutMs` and `signal` options |
| `apps/web/src/lib/ai/requests.ts` | `requestMeetingExtraction`, `requestTagSuggestions` |
| `apps/web/src/lib/ai/meeting-extraction-request.ts` | One-slot handler store for the two entry points |
| `apps/web/src/lib/notes/requests.ts` | `requestNoteDetail` — the pre-write version read |
| `apps/web/src/components/ai/MeetingExtractionDialog.tsx` | Transcript → review → insert, and task creation |
| `apps/web/src/components/ai/TagSuggestions.tsx` | Suggest → two separated groups → Apply |
| `apps/web/src/components/ai/AiPanel.tsx` | Launcher button only; no second stream, no second live region |
| `apps/web/src/components/editor/slash-commands.ts` | `/meeting-extraction`, availability derived from the store |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Mounts both new components beside `AiPanel` |

## Database and Data Changes

**None.** No migration, no new table, no new column. Neither transcripts, extractions, nor tag suggestions are persisted anywhere — there is no column they could occupy (ADR 0007). Tags and tasks created from the review screens are ordinary rows written through the existing Part 46/47 routes with their existing idempotency keys.

## API, Configuration, and Operational Changes

- **New routes:** `POST /api/v1/workspaces/:workspaceId/ai/meeting-extraction` and `POST /api/v1/workspaces/:workspaceId/ai/tag-suggestions`. Both `ai.use`, both `sensitive` rate-limit tier, both trusted-origin checked, both ordinary JSON (ADR 0013 bare payload) rather than SSE.
- **New error codes:** `AI_OUTPUT_INVALID` (422), `AI_PROVIDER_ERROR` (502). Both are surfaced by `request-json.ts`'s existing `code` passthrough and have client copy.
- **No new environment variable, no new feature flag, no new queue, no new dependency.** Both endpoints are synchronous and reuse the Part 67 governance gate, so the existing `FEATURE_AI_ENABLED` kill-switch and per-workspace quota/rate limits already cover them.
- `docs/openapi.json` is generated — regenerate with `pnpm --filter @notted/shared-validators build && pnpm --filter @notted/api openapi:generate`, never hand-edit.

## Security and Tenant-Isolation Notes

- **Both routes authorize before doing anything.** `ai.use` (owner/admin/editor, never viewer) gates both; `tag-suggestions` additionally authorizes `note.read` on the supplied `noteId`, which is what proves the note belongs to the caller's workspace.
- **No cross-tenant tag leak by construction.** The pool query pins `workspace_id` explicitly, the model never receives an id, and the partition can only emit ids that came out of that scoped query. A test asserts that a second workspace owning a tag of the same name comes back as `proposed` and that its id appears nowhere in the response.
- **Prompt injection.** Transcript and note text are wrapped in delimiters the model is told are untrusted data, a smuggled closing tag is stripped, and there is still no `tools` field anywhere in the provider contract. The repair prompt re-quotes the *rejected model output* inside its own stripped delimiters — that output derives from the transcript, so it is treated as hostile too.
- **No content in logs, rows, or errors.** The repair issue string is built from zod issues only. Provider failures map from HTTP status alone; no provider response body is read on the failure path, logged, or surfaced.
- **Nothing is written before confirmation** — the Plan's own verification criterion. Neither review screen issues an editor transaction, a task, a tag, or an assignment before Insert/Apply is pressed, and both have a test asserting it.
- **Metering is honest.** A repair pass is a second `complete()` call and therefore a second `ai_usage` row and a second rate-limit slot. It is not free.

## Verification Evidence

**Review #1 (2026-08-24) ran every gate and returned FAIL.** Nothing in this part's own logic was defective; the one fix touching it was the `import-x/order` error at `apps/web/src/components/editor/slash-commands.ts:31` (the `@/lib/ai/meeting-extraction-request` import now follows the `lucide-react` type import). `eslint src/components/editor/slash-commands.ts --max-warnings 0` is clean.

**From the implementing session, superseded by the note above:** quality gates were deliberately not run there and were deferred to the session reviewer. This session was scoped implement-only; all tests were authored but never executed. Nothing below is claimed to pass.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Not run** | Deferred to the session reviewer. |
| `pnpm format:check` | **Not run** | `pnpm exec prettier --write` was run over every touched file instead. |
| `pnpm type-check` | **Not run** | Deferred. Two typing choices are unverified and called out below. |
| `pnpm test` | **Not run** | Every new test is authored-but-unexecuted and will run for the first time under the reviewer's gate. |
| `pnpm build` | **Not run** | Deferred. |
| `pnpm test:ci` | **Not run** | Deferred. |
| `pnpm --filter @notted/shared-types build` | **Pass** | Ran twice — after authoring the contracts and again after the formatting pass. |
| `pnpm --filter @notted/shared-validators build` | **Pass** | Same; this is the only compile evidence that exists for this part. |
| `pnpm --filter @notted/api openapi:generate` | **Pass** | Booted the Nest app, discovered both new routes (which incidentally proves `MeetingExtractionService` resolves through DI), rewrote `docs/openapi.json`. |
| Playwright e2e | **Skipped** | Deliberately out of scope for this session; see follow-ups. |

Integration work done by the lead after the specialists returned: verified the `requestTagSuggestions` seam between the two frontend agents matches on both sides; verified `taskList`/`taskItem` and the `checked` attribute against `NOTE_DOCUMENT_NODE_TYPES` in the shared document contract (a node the contract rejects halts autosave, so this was checked rather than assumed); verified `composeDueDate(date, "")` yields an offset-bearing ISO instant that `isoTimestampSchema` accepts; mounted both components; and repaired the two registry-completeness suites the new slash entry broke.

**Review #2 (2026-08-25, fresh reviewer) and main-thread finalization.** Review #2 re-ran every gate from scratch and passed lint, format, type-check, test, build, the AI integration suite (17/17 live) and the first `pnpm test:ci` run with the dev stack up (api 85.27% statements / 76.80% branches, web 79.82% / 72.53%, all above the 70% floor; `src/ai` 98.63% / 90.19%). One unrelated `notes.integration.test.ts` case flaked once under the full four-package parallel run, passed alone and on the full re-run, and is untouched by these parts. Review #2 findings were fixed inline on the main thread: `MeetingExtractionDialog` inserted block-only meeting nodes at an inline position and split the author's paragraph (same defect class Review #1 fixed in `AiPanel`); it now uses the shared `blockInsertPos`; `AiStreamService.complete()` — which has no client `close` hook — now arms the `AI_REQUEST_TIMEOUT_MS` deadline. Final serial gate run after those fixes on 2026-08-25: `pnpm lint`, `pnpm format:check`, `pnpm type-check`, `pnpm test` (api 2423 passed / 161 skipped, web 1656, shared-validators 358, shared-types 49), env-prefixed `pnpm build`, and `test/ai.integration.test.ts` 17/17 — all green. Still unproven: live SSE flush behind `compression()` (needs a real provider key) and browser e2e coverage (recorded follow-up).

## Known Limitations and Follow-up Work

- **Two unverified typing choices**, both flagged by the implementing agent and neither compiled: the zod generic in `json-repair.ts` (`<Schema extends ZodType>` + `z.output<Schema>`, chosen because Zod 4 defaults `ZodType`'s parameters to `unknown` and `aiMeetingExtractionSchema` has a transform-differing input type), and a union-typed handler call in the new controller `it.each`. First thing for the reviewer's `type-check` to settle.
- **The two JSON routes carry no `Retry-After` header** on a governance rate-limit refusal, because `complete()` has no `Response` to set it on. The 429 envelope and its `retryAfterMs` are unaffected. Upgrade path is to move the header into the exception filter, where it would cover every route at once.
- **On-save passive auto-tagging is deferred.** Tag suggestion is explicit and user-triggered; the `ponytail:` note in the service records the enqueue-on-save upgrade path.
- **The 409 tag-name fallback searches only page 1** (limit 50) of a name-filtered listing. The filter is the exact name, so this is a theoretical ceiling.
- **Duplicate-task detection reads one bounded page** of workspace tasks (100). A workspace with more tasks than that can miss a duplicate — the badge is an aid, not a constraint; the user still decides.
- **`NOTE_TAG_LIMIT = 50` is a local constant** in `TagSuggestions.tsx`, because `tagIdsSchema` exposes its bound only through `.max(50)`.
- **No e2e specs.** A browser journey for both review screens is unwritten.
- **`graphify update .` was not run** — concurrent agents were editing the tree and a mid-flight rebuild would have produced a worse graph than a stale one.

## Handoff Notes

- **Part 70 consumes `AiStreamService.complete(input: AiCompletionInput): Promise<AiCompletion>`** and `parseJsonWithRepair({ raw, schema, repair })`. Both are exported from `apps/api/src/ai/index.ts`. `complete()` already meters, authorizes and fails closed; a caller supplies a prompt plan and nothing else.
- **`EditorShortcuts` must stay LAST** in the TipTap extension array. Unchanged by this part, still load-bearing.
- **Never hand model output to TipTap as a string.** Both new insert paths build JSON nodes. `insertContent`/`insertContentAt` route a string through `DOMParser.parseSlice`, which is HTML parsing and a live injection sink — this was one of Part 68's three blocking defects and the rule applies identically here.
- **Adding a `SLASH_COMMANDS` entry breaks two suites by design.** `suggestion-modules.test.ts` asserts the exact id array, and `editor-slash-commands.test.tsx` derives four counts from `SLASH_COMMANDS.length` plus a per-command execution loop. Both were updated here; the latter now registers a meeting-extraction handler in `beforeEach`, because the entry's `isAvailable` reads the one-slot store and would otherwise be filtered out of the menu — which would read as a broken menu rather than an unmounted dialog.
- **A repair pass costs a second provider call, a second usage row and a second rate-limit slot.** Anything tuning the prompts should watch the repair rate, since a prompt that drifts into producing unparseable output doubles the bill silently.
- `docs/openapi.json` is generated; `apps/api/test/openapi.contract.test.ts` fails in **both** directions, so a route without exactly one `OPENAPI_ROUTES` entry breaks the suite.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-24 | Claude Code session (lead part engineer) | Initial record — implementation complete, gates deferred to the session reviewer |
| 2026-08-24 | Claude Code review-fix session | Review #1 findings resolved; state still In progress pending Review #2 |
| 2026-08-25 | Claude Fable 5 main session | Review #2 + finalization: `MeetingExtractionDialog` inserted block-only meeting nodes at an inline position and split the author's paragraph (same defect class Review #1 fixed in `AiPanel`). Full serial gate green. State set to Complete. |
