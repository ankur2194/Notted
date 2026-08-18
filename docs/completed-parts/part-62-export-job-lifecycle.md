# Part 62 — Export job lifecycle

## Status

- **State:** Complete
- **Completed on:** 2026-08-18
- **Implemented by:** `backend-platform-engineer`, with two independent `quality-reviewer` passes and a main-session fix pass
- **Plan reference:** `Plan.md`, Part 62
- **Related records:** [Part 45](part-45-storage-retention-maintenance.md), [Part 50](part-50-establish-bullmq-queues-workers.md), [Part 61](part-61-email-subsystem.md), [Part 63](part-63-pdf-html-export.md), [Part 64](part-64-markdown-docx-zip-export.md)

## Objective

Turn the export scaffolding into a working feature. The `exports` table, the `notted-export` queue lane at concurrency 2, the `export.create|read|download|cancel` actions with their policy rules, and the retention sweep all already existed. Nothing that *created, ran or served* an export did — no module, no endpoints, no UI.

## Implemented Work

- New `apps/api/src/export/` module (singular, per `Notted.md`'s canonical tree): `export.module.ts`, `export.controller.ts`, `export.service.ts`, `export-job.producer.ts`, `export.worker.service.ts`, `export-object-key.ts`, `index.ts`. Handlers live in the domain module; the repo has no `queue/jobs/` directory.
- **Every transition is a conditional `UPDATE` carrying the expected prior status in the `WHERE`.** Zero rows means someone else won the race — handled, logged, never thrown, never a blind write.

  | Transition | From | To |
  | --- | --- | --- |
  | `create` | — | `queued` (+ outbox row, one transaction) |
  | `claim` | `queued` | `processing` |
  | `markReady` | `processing` | `ready` (object key, both expiry timestamps, `completed_at`) |
  | `markFailed` | `queued` \| `processing` | `failed` |
  | `cancel` | `queued` \| `processing` | `cancelled` |
  | `ready → expired` | **owned by `storage-maintenance.service.ts`** | not duplicated here |

- **Download streams; there is no presigned URL.** MinIO's port is unpublished, so a browser physically cannot reach a presigned URL in the documented deployment; ADR 0005 explicitly permits authorized streaming; and streaming leaves no bearer artifact to leak into logs, caches or a `Referer`. The route reuses the attachments controller's `contentDisposition` helper and sets `attachment`, `nosniff`, `default-src 'none'; sandbox`, `Cache-Control: private, no-store`, `Vary: Cookie` and `Accept-Ranges: none` — deliberately stricter than the attachment route.
- `signed_url_expires_at` is the outer **download-grant** ceiling, checked at download; `object_expires_at` drives the existing retention sweep. They are not collapsed — that split is why the schema has two columns (ADR 0007).
- **REST only, no tRPC subrouter**, under `@Controller("workspaces/:workspaceId/exports")`: `POST /`, `GET /`, `GET /:id`, `POST /:id/cancel`, `GET /:id/download`. `apps/web` has no tRPC client, and notifications and attachments both went REST-only. Creation requires an idempotency key.
- New shared contracts: `packages/shared-types/src/export.ts` (with `EXPORT_API_PATHS`) and `packages/shared-validators/src/export.schema.ts`, whose `exportOptionsSchema` is the `options` jsonb contract. Three new `ApiErrorCode` values — `EXPORT_EXPIRED`, `EXPORT_OBJECT_UNAVAILABLE`, `EXPORT_FORMAT_UNSUPPORTED` — all 409/422 so the web's `request-json.ts` surfaces the code.
- `NoteCapabilities` gained `canExport`, computed in `NotesService.toDetail` from the existing `export.create` policy. No new authorization action, resource kind or policy row was added.
- **`SUPPORTED_EXPORT_SOURCES` is `["note"]` only.** `project` and `workspace` are rejected with a clear error; the enum and policy stay ready for a follow-up part that specifies traversal and ordering.
- Part 62 shipped the `txt` renderer alone, so the whole state machine was end-to-end verifiable before Part 63 landed. Unsupported formats are rejected at create time, before any SQL.

## Deviations

- **`Plan.md` says "issue short-lived signed download links"; this streams instead.** The reasoning is above and is written into `export.controller.ts`. Recorded here because it is a deliberate Plan deviation, not an oversight.
- **`Notted.md:413-415` makes the exports bucket public; ADR 0005 and this part require it private.** Compose already applies `anonymous set none` and asserts it, so this is an already-resolved contradiction rather than a new change.

## Fixed after review

- **`rowScope` and `list` ignored the caller's declared `workspaceId`**, scoping only off tenant context, so a mismatched pair would have silently operated on a different workspace. `assertActiveWorkspace` was added; every single-row statement now passes through `rowScope`, which asserts the active workspace *and* applies `whereWorkspace`.
- **`announce()` ran the notification and the email in one `try`**, so a notification failure silently suppressed the email. Split into two independent blocks; neither can fail a completed export.
- **`export.schema.ts` used `.optional().default({})`**, which does not type-check because `.default()` takes an *output* value. Replaced with `.prefault({})`, verified against zod 4.4.3 for empty and partial input.
- **A cancel that won the race against `markReady` leaked its bytes permanently.** `markReady` is the only writer of `exports.object_key`, so losing that race left the row terminal with a `NULL` key — and the Part 45 sweep selects on `isNotNull(objectKey)`, so it could never reclaim the object. There is no orphan scan over the exports bucket either. Every cancel-during-upload would have leaked one artefact, silently and unboundedly, from a first-class UI action. The worker now deletes the object itself in that branch, best-effort, with three regression tests; the code comment that wrongly credited the sweep is corrected.

## Verification

- Live-PostgreSQL integration proving create → ready → download → notify, every illegal transition as a zero-row no-op, cancel from both states, expiry refusing a `ready` row, and cross-tenant plus non-requester denial.
- The denial test uses an **editor and a viewer** for the negative cases and an **admin** for a deliberate positive. Owners and admins are allowed another member's export unconditionally — `decideUser` returns `workspace_owner` / `workspace_admin` before any resource fact is read. That is deliberate policy, not an oversight, and it is asserted as a positive so a future narrowing fails loudly.
- Cross-tenant access answers **404, never 403**, at both the policy and the service layer, so concealment does not depend on the transport guard having run.

## Open risks and follow-ups

- **A `processing` row can wedge permanently.** Anything that throws after a successful claim leaves the row at `processing`; the retry's claim misses, the handler returns normally, and BullMQ marks the job complete instead of dead-lettering. There is no `processing → failed` staleness edge. Not data loss and not a leak — the user sees the dialog's timeout state, and a fresh idempotency key produces a working export. The upgrade path, recorded as a `ponytail:` comment at the branch, is a staleness reaper in the Part 45 sweep; that is smaller than teaching the branch to distinguish "someone else holds it" from "my own crashed attempt", a distinction the row cannot currently express.
- **`project` and `workspace` export sources remain unimplemented** by design.
- Concurrency behaviour is asserted through the SQL predicates, not by driving two workers at one row simultaneously.
