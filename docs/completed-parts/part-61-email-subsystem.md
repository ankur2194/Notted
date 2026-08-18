# Part 61 — Email subsystem

## Status

- **State:** Complete
- **Completed on:** 2026-08-18
- **Implemented by:** `backend-platform-engineer`, with two independent `quality-reviewer` passes and a main-session fix pass
- **Plan reference:** `Plan.md`, Part 61
- **Related records:** [Part 21](part-21-better-auth-backend.md), [Part 50](part-50-establish-bullmq-queues-workers.md), [Part 60](part-60-inline-comments-mentions.md), [Part 62](part-62-export-job-lifecycle.md)

## Objective

Give the product one email subsystem. Auth and invitation mail already flowed through the transactional outbox, but each worker built its HTML inline by string concatenation, there were no templates, no workspace branding, no welcome, mention or export-ready mail, and no unsubscribe or suppression handling at all. Part 60 stopped deliberately short and recorded "Part 61 owns delivery" as a hard boundary.

## Implemented Work

- New `apps/api/src/email/` module: `email.module.ts`, `email-renderer.service.ts`, `email-branding.ts`, `email-suppression.ts`, `email-templates.ts`, `workspace-email-producer.service.ts`, `email-delivery.worker.service.ts`, `index.ts`, and `templates/*.tsx` (layout, auth-action, password-reset-confirmation, welcome, invitation, mention, export-ready).
- Rendering is **React Email through `@react-email/render` only**. `@react-email/components` is deprecated and was not adopted; the templates use plain JSX and a shared table-based layout. `apps/api/tsconfig.json` gained `jsx: "react-jsx"` and `src/**/*.tsx`; the API ESLint rulesets widened to `{ts,tsx}`.
- **`EmailRendererService.render(templateKey, props) => {subject, html, text}` is deliberately the exact shape the old `renderAuthEmail()` returned.** That identity is the whole migration seam: the two existing workers dropped their inline renderers and called the shared one without touching their advisory-lock claims, their `authorizeSystem` blocks, or their reconciliation guards. The key union includes the five `AuthEmailPurpose` values verbatim, so `email_deliveries.template_key` keeps its existing values and **no data migration was needed**.
- One generic job type `email.deliver` on the existing `"transactional-email"` source queue, high priority, `authority: "system"`. The producer takes a **caller-supplied transaction**, so an email intent commits atomically with the business change that caused it (ADR 0006). The idempotency key derives from the *event* — `sha256({templateKey, recipient, relatedEntityType, relatedEntityId})` — so a replayed transaction collapses to exactly one email.
- The handler claims `queued → processing` conditionally, re-reads the subject entity from PostgreSQL (the payload carries identifiers only, never content), renders, sends, then writes `sent`.
- **SMTP failure maps to `reconciliation_required` plus `PermanentQueueJobError`, never an auto-retry.** Copied verbatim from the invitation handler, because SMTP acceptance is ambiguous and retrying an ambiguous send is how a system double-sends.
- Mention email is produced **alongside** the notification intent by `MentionNotificationProducer`, not from the Part 60 worker — two intents, two handlers, two failure domains, honouring Part 60's recorded boundary.
- Branding reads `workspaces.name`, `logoUrl` and `settings.branding.accentColor` defensively and falls back to platform defaults. Part 72 owns real branding.
- Suppression covers `mention` only, implemented as a **sentinel `email_deliveries` row** (`status: "suppressed"`, `relatedEntityType: "unsubscribe"`) rather than a new table, covered by the existing recipient index and toggled through the existing `NotificationController`. Marked with a `ponytail:` comment naming the upgrade path (an `email_preferences` table when Part 72 lands real per-user settings).
- The export-ready email **never embeds a signed URL**. It links an authenticated app page, because a mailbox is persistence and ADR 0005 excludes signed URLs from it.
- **No new environment variables in Part 61 or 62.** Everything needed was already registered. Stated explicitly so a reviewer does not read it as an omission.

## Deviations and deferrals

- **Digest email is deferred.** `Notted.md` marks it optional, and no scheduler, aggregation window or preference store exists to build it on.
- **`@react-email/components` was not used** despite being the obvious package. It is deprecated; `@react-email/render` plus plain JSX carries the same output with one dependency instead of a tree.

## Fixed after review

- **The mention email promised an unsubscribe control that did not exist.** `mention.tsx` links "Manage email preferences" at `/workspaces/:id/settings`, but the suppression backend shipped with a `POST` and no `GET`, and the web app had no control at all — a toggle cannot render its own state without a read path. Closed by adding `NotificationService.getEmailPreference`, a `GET .../notifications/email-preference` route, `loadMentionEmailPreference` / `setMentionEmailPreference`, and `MentionEmailPreference.tsx` on the workspace settings page. The control is rendered for **every member**, not gated on `canManage`: every other block on that page is a workspace-admin setting, but this one is the reader's own mail preference, and a member who cannot rename the workspace must still be able to stop being emailed. The API resolves the address from the authenticated id, so a member can only ever change their own.
- **Suppression was read case-insensitively but deleted case-sensitively.** `isSuppressed` matches on `lower(recipient)`; the sentinel predicate used a raw `eq`. A mixed-case row written before `normalizeRecipient` existed — a case the code comment explicitly anticipates — would have been *seen* by the reader and missed by the deleter, leaving that user unsubscribed with no way back. Both now share one private `mentionSuppressionSentinel` helper, so the read and the write cannot drift.

## Verification

- Unit suites for the renderer, branding, suppression, the producer and the delivery worker; the delivery worker's integration suite runs against live PostgreSQL.
- The escaping test asserts a hostile note title renders as `&lt;img …&gt;` and that neither `<img` nor `<script` survives.
- Both migrated workers were diffed line by line to confirm their claim, authorization and reconciliation logic is byte-identical.

## Open risks and follow-ups

- **Suppression sequential-scans.** `lower(recipient)` cannot use `email_deliveries_recipient_idx`, which is a plain btree on the raw column. Acceptable while the table is small and the check runs once per outbound email; the `ponytail:` comment names the expression index as the upgrade path.
- **Branding is placeholder-grade** and owned by Part 72.
- **Emails were never inspected visually.** `Notted.md`'s "Mailpit snapshots render correctly on desktop and mobile" is asserted at the level of a `sent` delivery row, not a rendering. Unproven.
