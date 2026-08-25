# Part 72 — Branding and customization

## Status

- **State:** Complete
- **Completed on:** 2026-08-25
- **Implemented by:** Claude Code session (lead part engineer + backend/frontend specialists)
- **Plan reference:** `Plan.md`, Part 72
- **Related records:** [Part 26](part-26-workspace-lifecycle-apis.md) (the workspace lifecycle that created `workspaces.settings` and has been seeding an `accentColor` ever since), [Part 40](part-40-secure-object-storage.md) / [Part 41](part-41-image-ingestion-processing.md) (the multipart upload parser and the image pipeline this part reuses verbatim), [Part 45](part-45-storage-quotas-cleanup.md) (the orphaned-object sweep that collects superseded logos), [Part 61](part-61-email-subsystem.md) (email branding, `resolveBranding`), [Part 71](part-71-audit-logging-admin-views.md) (`recordAudit`, the only sanctioned audit writer)
- **Related decision:** [ADR 0014](../decisions/0014-workspace-branding-and-custom-domains.md) — *Proposed*; its `## Custom domains` section is Part 73's to fill.

## Objective

Let a workspace look like the organisation that owns it: an uploaded logo that renders in
the app *and* in email, and an accent colour that re-tints the interface — without letting
either become a way to break accessibility, leak data, or take a workspace's own
administrators hostage.

The governing verification from `Plan.md` is that **branding applies consistently across the
app and emails** and that **broken assets fall back to Notted branding**.

## Implemented Work

- **Logo service (`workspaces/workspace-logo.service.ts`).** `upload` / `remove` / `read`.
  Upload sniffs the image (declared type ignored), re-encodes through the Part 41
  `ImageProcessingService` to the 200 px WebP `thumbnail` rendition (`medium` as fallback),
  PUTs it under a fresh 128-bit token, then commits `workspaces.logo_url` and the audit row
  in one transaction, then best-effort deletes the superseded object. `read` takes **no
  principal and no tenant context** — the token is the whole authorization, compared with
  `timingSafeEqual`.
- **Logo transport (`workspaces/workspace-logo.controller.ts`).** `POST` and `DELETE` under
  `@RequireAuthorization({ action: "settings.update" })` plus
  `assertTrustedMutationOrigin`; `GET :token` deliberately carries no guard. The multipart
  body is read in the controller, after authorization, so `parseSingleFileUpload` enforces
  the 2 MiB ceiling during transfer and no body byte is consumed for a caller who may not
  write. The GET writes its own header block: `Content-Type: image/webp`, `nosniff`,
  `public, max-age=31536000, immutable`, `ETag`, `inline`, and a `304` on a matching
  `If-None-Match`.
- **Accent colour contracted.** `workspaceSettingsSchema` gained
  `accentColor: hexColorSchema.nullable().optional()`; `normalizeStoredSettings` stopped
  **stripping** the key it had been discarding since Part 26; `knownSafePersistedSettings`
  preserves it across a partial settings save; `applyUpdateTransaction` **deletes** the key
  on an explicit `accentColor: null` so readers face one absence, not two.
- **Contrast policy (`packages/shared-validators/src/color-contrast.ts`).** WCAG 2.2
  relative luminance and contrast ratio as pure arithmetic, plus `accentContrast()` returning
  `{ ratioOnWhite, level }` over `fail` / `warn` / `ok`. One implementation, used by the API
  to refuse and by the settings form to explain.
- **`ACCENT_CONTRAST_TOO_LOW`.** A new `ApiErrorCode` (422) raised by
  `WorkspacesService.validateSettings` when the accent measures below 3:1 against white.
  Shape is validated by Zod first; legibility is checked after, in the service, so the
  refusal can carry the measured ratio and a named remedy.
- **Shell bootstrap carries branding.** `shellWorkspaceMembershipSchema` gained
  `logoUrl` and `accentColor`, both required-and-nullable; `ShellService.accentColorOf`
  reads the accent defensively out of the untyped `settings` jsonb.
- **Runtime theming (`apps/web/src/lib/shell/accent-style.ts`).** `accentStyle()` returns a
  style object setting `--color-primary` and `--color-ring` on the shell root, re-checking
  `#rrggbb` immediately before the value becomes CSS. `DashboardShell` applies it; a `null`
  or malformed accent emits **no style attribute at all**.
- **`apiAssetUrl` (`apps/web/src/lib/api/api-origin.ts`).** One module that answers "where is
  the API", and one function that turns a persisted app-relative path into an absolute asset
  URL — refusing absolute URLs, `//host` forms, and non-`/` schemes, because its input comes
  out of the database and lands in an `<img src>`.
- **`WorkspaceAvatar` became a client component**, for one reason: `onError`. A logo can
  break after it was persisted (storage disabled, object swept, slow network), and the plan's
  verification is explicitly that broken assets fall back to Notted branding — a runtime
  event a server component cannot notice. It falls back to a deterministic initials block or
  a caller-supplied node, and resets its broken flag when the resolved URL changes.
- **Sidebar branding.** A workspace with a published logo shows its own mark; everything else
  shows the Notted mark.
- **Settings UI (`WorkspaceSettings.tsx`).** A logo upload/remove pair (deliberately *not*
  part of the settings form — it is multipart and immediate), and an accent control pairing a
  native `<input type="color">` with a hex text field, a live contrast readout from the shared
  function, a reset-to-default button, and a save that is blocked while the accent measures
  `fail`.
- **Email branding follows the app.** `safeLogoUrl` now resolves an app-relative `logoUrl`
  against `API_URL` (rejecting `//` protocol-relative values and non-`http(s)` schemes), so
  the same persisted string works in a browser and in a mail client.
- **Audit.** `workspace.logo.update` and `workspace.logo.delete` via `recordAudit`, inside the
  same transaction as the row change, carrying identifiers and sizes only.

## Important Decisions

- **A dedicated route, not an `attachments` row.** An attachment has a note, is authorized as
  `file.read` against it, and is served privately. A logo has no note, is branding rather than
  content, and its most important consumer is an `<img>` in an email client with no session.
  Reusing the pipeline meant an attachment with a null note or a public hole in `file.read`.
- **The GET is public and the token is the authorization.** 128 bits, constant-time compared,
  rotated on every replace or delete. Every miss is the same 404, so the route cannot enumerate
  workspaces or reveal which ones have branding.
- **`logoUrl` is app-relative.** One stored string, resolved against the API origin in the
  browser and against `API_URL` in email. The database never holds a deployment hostname.
- **`public, immutable` caching**, unlike the attachment route's `private`. The token changes
  on replacement, so a shared cache cannot serve a stale logo, and there is no principal for
  the entry to be specific to.
- **Order of operations on upload: encode → PUT → commit → delete previous.** A failure before
  the PUT leaves nothing; a failure after it leaves one unreferenced object, which is strictly
  better than a row pointing at bytes that were never written. The previous object's removal is
  swallowed on failure — the row is already correct and Part 45's sweep collects the remainder.
- **`accentColor: null` means reset; `undefined` means leave alone.** The reset deletes the
  stored key rather than writing `null`, so the detail mapper, the shell, and the email parser
  all have exactly one absence to handle.
- **The contrast rule lives in the service, not in a Zod refinement.** A refinement can only
  say "invalid"; the caller needs `ACCENT_CONTRAST_TOO_LOW` plus the measured ratio so the form
  can name the remedy.
- **Two thresholds, not one.** 3:1 refuses (WCAG 2.2 §1.4.11 non-text); 4.5:1 only warns,
  because refusing every accent that cannot also carry body text would reject most real brand
  palettes and the accent paints surfaces, not paragraphs.
- **White is the reference colour**, not the theme's `#f8fafc` foreground — it is the strictest
  comparison that actually occurs on the page.
- **`--color-ring` moves with `--color-primary`.** A focus ring left slate on a re-tinted button
  is the accessibility bug this feature would otherwise ship.
  `--color-primary-foreground` is deliberately *not* touched: the 3:1 floor already guarantees
  near-white text stays legible.
- **Only two custom properties.** Tailwind 4 resolves `bg-primary` / `ring-ring` to
  `var(--color-*)` at the use site, so two overrides re-tint everything below the shell root
  with no theme provider, no class permutations, and no stylesheet rewriting.
- **Branding rides the existing shell bootstrap.** Both fields are needed on the first paint of
  every page; a second round-trip would flash the default mark and then swap.
- **No custom CSS at all** — not a disabled feature, an absent one. See ADR 0014 for the three
  threats and the five prerequisites.
- **No migration.** Both columns already existed; this part is the first writer of a
  first-party value into either.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/workspaces/workspace-logo.service.ts` | Upload / remove / tokenised public read; token minting, key derivation, `parseWorkspaceLogoUrl`, constant-time match |
| `apps/api/src/workspaces/workspace-logo.controller.ts` | The three routes, the multipart read, and the public GET's header block |
| `apps/api/src/workspaces/workspaces.module.ts` | Registers the service and controller; pulls in the attachments/storage providers |
| `apps/api/src/workspaces/workspaces.service.ts` | `normalizeStoredSettings` stops stripping the accent; `knownSafePersistedSettings`; the `accentColor: null` delete; `validateSettings` contrast check |
| `apps/api/src/workspaces/workspaces.constants.ts` | `WORKSPACE_AUDIT_ACTIONS.logoUpdate` / `.logoDelete` |
| `apps/api/src/workspaces/index.ts` | Barrel exports for the new service and controller |
| `apps/api/src/shell/shell.service.ts` | `accentColorOf`; `logoUrl` and `accentColor` on every bootstrap membership |
| `apps/api/src/email/email-branding.ts` | `safeLogoUrl` resolves app-relative paths against `API_URL` |
| `apps/api/src/openapi/openapi.routes.ts` | Documentation entries for the three logo routes |
| `packages/shared-validators/src/color-contrast.ts` | WCAG luminance/ratio, `accentContrast`, `ACCENT_CONTRAST_MIN_RATIO` (3), `ACCENT_CONTRAST_TARGET_RATIO` (4.5) |
| `packages/shared-validators/src/common.schema.ts` | `hexColorSchema` — six-digit `#rrggbb` only, no shorthand and no alpha |
| `packages/shared-validators/src/workspace.schema.ts` | `accentColor` on `workspaceSettingsSchema`; `workspaceLogoResultSchema` |
| `packages/shared-validators/src/shell.schema.ts` | `logoUrl` / `accentColor` on `shellWorkspaceMembershipSchema` |
| `packages/shared-types/src/workspace.ts` | `WorkspaceSettings.accentColor`, `WorkspaceLogoResult`, `WORKSPACE_API_PATHS.logo` |
| `packages/shared-types/src/shell.ts` | Branding fields on the shell membership type |
| `packages/shared-types/src/api.ts` | `ACCENT_CONTRAST_TOO_LOW` in `ApiErrorCode` |
| `apps/web/src/lib/api/api-origin.ts` | `apiOrigin()` and `apiAssetUrl()` — the seam Part 73 extends |
| `apps/web/src/lib/shell/accent-style.ts` | `accentStyle()` — the two custom properties |
| `apps/web/src/lib/workspaces/paths.ts` | `workspaceLogoPath()` for the two mutations only |
| `apps/web/src/lib/workspaces/requests.ts` | `uploadWorkspaceLogo` (FormData) and `deleteWorkspaceLogo` |
| `apps/web/src/components/workspaces/WorkspaceAvatar.tsx` | Client component; resolves through `apiAssetUrl`, falls back on `onError` |
| `apps/web/src/components/workspaces/WorkspaceSettings.tsx` | Logo upload/remove and the accent control with its live contrast readout |
| `apps/web/src/components/layout/Sidebar.tsx` | Workspace mark when a logo is published, Notted mark otherwise |
| `apps/web/src/components/layout/DashboardShell.tsx` | Applies `accentStyle` to the shell root |
| `packages/shared-validators/src/color-contrast.test.ts` | Luminance, ratio, and the two thresholds |
| `apps/web/src/lib/api/api-origin.test.ts` | `apiAssetUrl` refusals: absolute, `//host`, non-`/`, empty |
| `apps/web/src/lib/shell/accent-style.test.ts` | Emits properties for a valid hex, `undefined` otherwise |
| `apps/web/src/components/workspaces/workspace-avatar.test.tsx` | Logo render, initials fallback, `onError` fallback |
| `apps/api/src/email/email-branding.test.ts` | App-relative resolution against `API_URL` and the hostile-value refusals |
| `apps/api/src/workspaces/workspace-logo.service.test.ts` | Key/URL round-trip, sniff refusal, audit metadata, replace-then-discard ordering, 404 uniformity, storage-disabled 503 |
| `apps/api/src/workspaces/workspace-logo.controller.test.ts` | Trusted-origin on the mutations, the public GET header block, 304 revalidation, and that GET needs no principal |
| `apps/api/test/workspace-logo.integration.test.ts` | Database-gated: cross-tenant 404, viewer/editor 403, token supersession, idempotent removal |

## Database and Data Changes

- **There is NO migration.** `workspaces.logo_url` (Part 18) and `workspaces.settings`
  (Part 26) both already existed. Part 72 is the first code that writes a first-party value
  into either: `logo_url` had only ever been "a URL the branding renderers may use" with
  nothing able to put one there, and `settings.accentColor` had been persisted and seeded
  since Part 26 while `normalizeStoredSettings` discarded it on the way out.
- **No column, no index, no constraint, no backfill, no table rewrite, and no lock** of any
  kind. `pnpm --filter @notted/api db:generate` produces nothing for this part.
- **No rollback SQL.** Rollback is code-only: reverting the part makes
  `normalizeStoredSettings` strip the accent again and removes the three logo routes.
  Stored values become inert — an `accentColor` key nothing reads and a `logo_url` path
  nothing serves.
- **Objects, not rows, are the rollback residue.** Renditions already written to
  `attachments/workspaces/<workspaceId>/logo/<token>.webp` would be left in the bucket for
  Part 45's orphaned-object sweep to collect.
- **Seed:** unchanged in shape. The two seeded workspaces already carried
  `settings.accentColor` (`#2563eb` for Alpha, `#0f766e` for Beta); this part is simply the
  first build in which those values are visible to a reader. No seeded logo.

## API, Configuration, and Operational Changes

- **New routes:** `POST /api/v1/workspaces/{workspaceId}/logo`,
  `DELETE /api/v1/workspaces/{workspaceId}/logo`, and the public
  `GET /api/v1/workspaces/{workspaceId}/logo/{token}`. All three are documented in
  `docs/openapi.json` (regenerated) and in `docs/API.md` under **Branding**. No tRPC
  counterpart — the upload is multipart and the read is public, neither of which belongs on
  the typed RPC surface.
- **No new authorization action.** Both mutations reuse `settings.update` over the `settings`
  resource, so an existing admin already holds the permission.
- **New audit actions:** `workspace.logo.update` and `workspace.logo.delete`, entity type
  `workspace`, metadata limited to `{ bytes, sourceType }` and `{}` respectively.
- **New error code:** `ACCENT_CONTRAST_TOO_LOW` (422).
- **New shell bootstrap fields:** `logoUrl` and `accentColor` on every membership and on
  `currentWorkspace`. Additive and non-breaking for a client that ignores them.
- **No new environment variable and no new dependency.** `API_URL` already existed; email
  branding is its new consumer for logo resolution. Object storage (`MINIO_*`) already
  existed; when it is not configured, logo upload/read answer a stable
  `503 SERVICE_UNAVAILABLE` and the app renders the initials fallback.
- **Storage:** logos live in the existing `attachments` bucket under
  `workspaces/<workspaceId>/logo/`. They are **not** attachment rows and therefore do not
  count against the workspace storage quota. At 200 px WebP each, the footprint is
  negligible; superseded objects are removed on replace and swept by Part 45 if that removal
  fails.
- **Rate limiting:** the mutations use the standard authenticated tiers. The public GET is
  cheap, immutable, and cacheable, and no bespoke tier was added for it.

## Security and Tenant-Isolation Notes

- **The public GET is the one deliberately unauthenticated resource route in the API.** Its
  authorization is a 128-bit random token compared in constant time against the token stored
  in `workspaces.logo_url`. `parseWorkspaceLogoUrl` additionally requires that the workspace
  id embedded in the stored path equals the workspace being read, so a row that somehow named
  a foreign workspace could not be used to reach that workspace's bytes.
- **Every miss answers the same `404`** — unknown workspace, no stored logo, superseded token,
  missing object, malformed token. The route is not an existence oracle.
- **Revocation is real:** replacing or deleting a logo mints a new token, so previously shared
  URLs (including ones sitting in old email) stop resolving.
- **Both mutations are workspace-scoped twice over:** `@RequireAuthorization` decides
  `settings.update` before a body byte is read, and every statement inside carries
  `whereWorkspaceId(workspaces, tenantContext)`.
- **CSRF:** `assertTrustedMutationOrigin` on both mutations. The GET needs none — it is safe,
  and requiring an `Origin` would break the email consumer it exists for.
- **The sniffed type is authoritative** (ADR 0005); the declared multipart `Content-Type` and
  the filename are never consulted. Everything stored is a WebP this API encoded, so serving
  it `inline` cannot be a content-type attack, and `nosniff` states it anyway.
- **The 2 MiB ceiling is enforced during transfer**, so a lying `Content-Length` cannot get
  past it. Image-processing failures return a stable refusal; the specific reason stays
  in-process.
- **Audit metadata carries sizes and the source format only, and deliberately NOT the object
  token.** The token is the bearer capability for a public URL, and `audit_logs` is
  CSV-exportable by every workspace admin. Part 71's `redactAuditMetadata` denies any key
  ending in `token` for exactly that reason; the first draft of this part put one there and
  had it silently blanked, which is how the mistake was caught. `bytes` is the size actually
  kept, not the size uploaded. The row's workspace, actor and timestamp are the audit fact.
- **`apiAssetUrl` is a trust boundary in the browser:** its input is a database value and its
  output is an `<img src>`, so it accepts only app-relative `/…` paths and refuses absolute
  URLs, `//host` protocol-relative forms, and `javascript:` / `data:` schemes. `safeLogoUrl`
  applies the same discipline server-side for email.
- **`accentStyle` re-validates `#rrggbb`** immediately before the value becomes CSS, even
  though the API validated it on write and the shell schema validated it on read — that is the
  last hop before an arbitrary string would be interpolated into a style.
- **The contrast floor is a security-adjacent accessibility control**: it is enforced
  server-side, so a client that skips the form cannot save an unreadable focus ring for every
  member of a workspace.
- **No custom CSS** — see ADR 0014 for why the capability is absent rather than disabled.

## Verification Evidence

Gates were run serially by two independent review rounds and a final main-thread pass on 2026-08-25 (dev stack on the alternate-port root `.env`; the e2e stack was never started). Results below are from the final pass unless a note says otherwise.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Pass** | Repo root, 2026-08-25 final run: `Tasks: 4 successful, 4 total`, `--max-warnings 0`, no problems |
| `pnpm format:check` | **Pass** | `All matched files use Prettier code style!` |
| `pnpm type-check` | **Pass** | `Tasks: 6 successful, 6 total` |
| `pnpm test` | **Pass** | api `204 passed \| 27 skipped (231)`, web `155 passed (155)`, shared-validators `16 passed`, shared-types `4 passed`; `node --test scripts/*.test.mjs` `# pass 21 / # fail 0` |
| `pnpm test:ci` | **Pass** | `DATABASE_URL` (postgres 5433) and `REDIS_URL` (6380) exported, dev stack on the alternate-port `.env`: api `224 passed \| 7 skipped`, coverage `85.57 / 77.07 / 86.73 / 87.81`; web `155 passed`, `79.9 / 72.82 / 81.42 / 82.35`; shared-validators branch `77.17`; shared-types branch `95.69` — every threshold ≥ 70 met. The 7 skipped API suites are MinIO/Meilisearch/Chromium/`AUTH_E2E`-gated |
| `pnpm build` | **Pass** | Prefixed with the three `NEXT_PUBLIC_*` values: `Tasks: 4 successful, 4 total` |
| `pnpm --filter @notted/api db:check` | **Pass** | `Everything's fine 🐶🔥` with migrations `0021`–`0023` in the journal |
| `pnpm --filter @notted/api openapi:generate` | **Pass** | Regenerated `docs/openapi.json`; the builder asserts that documented and discovered routes match **in both directions**, so all three logo routes are proven both registered and documented |
| `pnpm --filter @notted/shared-types build` | **Pass** | |
| `pnpm --filter @notted/shared-validators build` | **Pass** | |
| Live logo upload / public fetch / revocation behaviour | **Pass** | `test/workspace-logo.integration.test.ts` ran against the live database inside `pnpm test:ci` and in reviewer round 2's focused run |
| Browser verification of accent application and broken-asset fallback | Not run | No Playwright journey exists (see limitations); `dashboard-shell.test.tsx` and `workspace-avatar.test.tsx` cover both in jsdom |

## Known Limitations and Follow-up Work

- **Custom CSS is not shipped.** There is no schema field, no API, and no UI — it is absent,
  not disabled. ADR 0014 records the three threats (exfiltration via `url()` / `@import` on
  attribute selectors, UI spoofing of the trusted chrome, and administrator lockout) and the
  five prerequisites (a CSP `style-src` allow-list from Part 74, a server-side sanitiser, a
  scoped root, a safe-mode escape hatch, and the production/TLS parts).
- **The public logo GET is unreachable to API-key callers.** The route carries no
  authorization specification, and `ApiKeyRouteGuard` is default-deny for any route without
  one, so an API-key caller gets `403` on a URL that succeeds anonymously. This is the guard
  working correctly; the fix, if it is ever wanted, is an explicit "public route" marker the
  guard recognises rather than a scope on this route. Documented in `docs/API.md`.
- **Superseded logo objects rely on Part 45's orphan sweep.** The post-commit delete is
  best-effort and its failure is swallowed; there is no retry and no dead-letter. Marked with
  a `ponytail:` comment in the service. Upgrade path is a `job_outbox` cleanup intent if
  orphan volume ever becomes measurable.
- **The accent overrides only `--color-primary` and `--color-ring`.** Secondary, destructive,
  muted, and chart surfaces keep the platform palette, so a workspace cannot fully re-theme
  the product — only re-tint its primary surfaces and focus rings. Deriving a complete,
  contrast-safe palette from one hex value is a design-system project, not this part.
- **No Playwright journey** covers upload → render → email → revocation. Browser coverage is
  deferred as it was for Parts 67–71.
- **The `medium`-variant fallback in `upload` is not exercised.** The processor double always
  yields a `thumbnail`, and forcing the fallback would only test the double. It is reached
  only for a source that produces a medium rendition but no thumbnail, which the real Sharp
  pipeline does not currently do.
- **No test drives the real Sharp encoder.** Every API suite injects an `ImageProcessor`
  double, so "a real PNG becomes a real 200 px WebP" is proven by Part 41's own
  `image-processing.service.test.ts` for the attachment path and assumed here. The seam is
  shared, so the assumption is that Part 41's coverage transfers.
- **`workspaces.domain` remains inert.** It is stored, unique, and validated, and nothing
  reads it. Part 73 owns verification, routing, and TLS.
- **Logos do not count against the storage quota.** Deliberate at 200 px WebP, but it does
  mean a workspace's reported usage slightly understates its real object footprint.

## Handoff Notes

- **`logoUrl` is APP-RELATIVE and must never be rendered raw.** Resolve it with
  `apiAssetUrl()` in the browser and against `API_URL` (`safeLogoUrl`) in email. Putting the
  stored string straight into an `<img src>` works only by accident on a same-origin
  deployment and breaks everywhere else.
- **The logo token is minted server-side and must never be reconstructed by a client.**
  `workspaceLogoPath()` builds the *mutation* path only; the readable URL comes back from the
  API (in `WorkspaceLogoResult`, the workspace detail, and the shell bootstrap) and is the
  only correct source. A client that guesses a token gets a 404, as designed.
- **`accentColor: null` means reset; `accentColor: undefined` means leave alone.** Any new
  writer of `settings` must honour that distinction, and the reset must continue to delete the
  key rather than store `null`.
- **Anything new added to `workspaces.settings` must be added to both
  `workspaceSettingsSchema` and `knownSafePersistedSettings`.** A key present in only the
  first will be erased by the next partial settings save — that is exactly the bug the
  seed-only `scenario` marker exists in the second function to prevent.
- **`apps/web/src/lib/api/api-origin.ts` is the seam Part 73 extends.** It is the one place
  the browser decides where the API lives, written that way so a custom-domain deployment
  where the API answers on the app's own origin has a single line to change.
- **Do not "fix" the public GET by giving it an authorization spec** to make API keys work —
  that would authenticate a route whose entire purpose is to be fetchable by a mail client.
- **The 3:1 floor is enforced server-side and the form only mirrors it.** Removing the
  client-side check degrades the message, not the guarantee; removing the server-side check
  removes the guarantee.
- **`--color-primary-foreground` is intentionally left alone.** Overriding it would break the
  invariant that makes the 3:1 floor sufficient.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-25 | Claude Code session | Initial record — implementation complete, quality gates deferred to the session reviewer |
| 2026-08-25 | Claude Code session | Review round 1 fixes. **L1:** the logo upload paired HTTP 415 with the `UNPROCESSABLE_ENTITY` code. Part 40 had deliberately deferred a dedicated member (its record, item 14); that follow-up is now taken — `UNSUPPORTED_MEDIA_TYPE` is added to `ApiErrorCode`, mapped to 415 in `ApiExceptionFilter`, and adopted by all six 415 call sites (`workspace-logo.service.ts`, `attachments.controller.ts` ×2, `attachments.service.ts` ×2, `multipart-upload.parser.ts`). 422 responses are untouched. Documented in `docs/API.md`; nine assertions updated. **L2:** the logo hint said the rendition is published at a "private, unguessable address"; the route is public (immutably cached, unguessable token), so the wording now says "public but unguessable". **H5:** `workspace-settings.test.tsx` asserted a "Replace logo" button that does not exist (now the file input and "Remove logo" button, both disabled for a viewer), expected a settings patch without `accentColor` (`buildPatch` re-sends `settings` whole, so the unchanged accent rides along as `null`), and resolved `role="status"` ambiguously now that the logo and accent live regions coexist. |
| 2026-08-25 | Claude Code session | Review round 2 and final gates. **L-2:** `WorkspaceAvatar` resolved the logo URL during render, and `apiOrigin()` differs between the server (build-time `NEXT_PUBLIC_API_URL`) and a browser on a Part 73 custom host (`window.location.origin`), so SSR HTML and the first client render disagreed on `<img src>` exactly there; `apiAssetUrl` now takes an optional origin and the component reads it through `useSyncExternalStore` with `primaryApiOrigin()` as the server snapshot, so hydration matches and the browser value applies on the first client render. **N-1:** `test/workspace-logo.integration.test.ts` embedded four literal NUL bytes (git/grep classified the file as binary); now `\u0000` escapes. Final serial gates all pass — table updated. Status moved to Complete. |
