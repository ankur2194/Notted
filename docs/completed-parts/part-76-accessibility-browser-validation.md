# Part 76 — Accessibility and cross-browser validation

## Status

- **State:** Complete — on its **automated** scope, with two named manual residuals
- **Completed on:** 2026-08-26
- **Implemented by:** Claude Code implementation session, 2026-08-26 (implement-only); gates and browser runs executed by review-remediation session `3fb3cda0`, 2026-08-26
- **Plan reference:** `Plan.md`, Part 76
- **Related records:** [Part 75 — automated test pyramid](part-75-automated-test-pyramid.md), [Part 72 — branding and customization](part-72-branding-and-customization.md), [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md)

**Completeness statement, stated before any evidence so it cannot be missed.** Plan.md Part 76 asks for
*"automated axe scans **plus** manual keyboard/screen-reader checks"*. The automated half is built, run,
and green — including two genuine WCAG 2.2 AA failures found in the product and fixed. The manual half
requires a human at an NVDA or VoiceOver stack and at a real Windows High Contrast Mode desktop; **no
agent can perform either, and neither becomes performable by waiting.** They are therefore carried as
**RESIDUAL 1** and **RESIDUAL 2** in Known Limitations, each with the exact procedure a human should
follow, and this part is judged complete on the scope this session could execute. **Nothing here claims
screen-reader behaviour, and an axe pass is never reported as conformance.** axe detects roughly a third
to a half of WCAG issues; what is green below is a floor, not a certification.

## Objective

Plan Part 76 asks for a WCAG 2.2 AA audit — semantic structure, keyboard operation, focus order,
dialogs, menus, editor toolbar, drag alternatives, contrast, reduced motion, zoom, announcements, and
error association — plus current Chrome, Firefox, Safari/WebKit and Edge behaviour, with attention to
contenteditable, clipboard, print, and WebAuthn. Its completion criterion is that automated axe scans
**plus manual keyboard and screen-reader checks** leave no unresolved serious issues on core journeys.

Much of the accessibility surface was already built by earlier parts. The audit's job was to find what
was *asserted nowhere* and what was *actually broken*, and it found one of each: there was no axe
coverage at all, and the global focus indicator disappeared entirely under Windows High Contrast Mode.

**Read the Verification Evidence section before trusting anything here.** The implementing session wrote
files and ran nothing. The remediation session ran every automated gate and all three browser engines —
and found that the axe helper could not even be *loaded*, so none of this had ever executed. Half of this
part's completion criterion — the manual screen-reader pass — is still not merely unrun but cannot be run
by an agent at all, which is why it is carried as a named manual residual rather than claimed.

## Implemented Work

- **`apps/web/e2e/axe.ts`** — shared axe helper, a plain module rather than a `*.spec.ts` so Playwright's
  `testMatch` does not collect it (the same arrangement as `mailpit.ts` and Part 75's `accounts.ts`).
  `scan(page, { surface, include?, exclude? })` injects `axe.min.js` via `page.addScriptTag`, runs
  `axe.run` against `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, filters to `serious` and
  `critical`, subtracts a documented `ACCEPTED_VIOLATIONS` allowlist **after** the run while printing
  what it subtracted, and fails with `ruleId @ selector — help`.
- **`axe-core@4.12.1` as an exact-pinned devDependency of `apps/web`.** That version is already in the
  pnpm store as a transitive dependency of `eslint-plugin-jsx-a11y`, so the declaration adds a name to
  `apps/web/package.json` and reconciles the lockfile without pulling a new artefact.
- **`apps/web/e2e/accessibility.spec.ts`** — self-provisioning through `accounts.ts`. axe scans of
  `/login` (unauthenticated), the dashboard shell, the note editor seeded with a table, an image with
  alt text and a task list, the tasks board/list, search results, and one open dialog
  (`CreateNoteDialog`). Plus the three checks axe cannot make: a `forced-colors: active` focus-indicator
  assertion, a focus-order and dialog-focus-restore assertion, and a polite-live-region non-nesting
  invariant.
- **`apps/web/src/styles/globals.css`** — a new `@media (forced-colors: active)` block giving
  `:focus-visible` a real `outline: 2px solid Highlight !important; outline-offset: 2px !important`
  where custom-property-driven colour is load-bearing. This is the one genuine defect the audit found;
  see the dedicated section below.
- **`apps/web/e2e/cross-browser.spec.ts`** — deliberately small, running on whichever project is
  selected so chromium exercises it as a canary in the default run. Covers contenteditable typing,
  a synthetic `text/html` paste, print, reduced motion and reflow, and WebAuthn degradation. Every one
  of those choices avoided a Chromium-only API; see Important Decisions.
- **`apps/web/e2e/print-selectors.ts`** — `PRINT_HIDDEN_SELECTORS` extracted out of
  `print-export.spec.ts` into a shared non-spec module, because importing it *from* the spec would
  re-register that spec's tests in every file that imported it. Swapping that import is the only edit
  made to `print-export.spec.ts`.
- **`docs/standards/testing.md`** gained a delimited Part 76 section below Part 75's block: the axe
  helper and its one allowlist rule, the two cross-browser commands, the explicit-spec-path rule, why
  those commands need no setup, and the recorded Edge substitution.
- **`docs/standards/frontend.md`** gained a browser-support position.

## Important Decisions

- **The `forced-colors` fix is the only production change in this part.** Everything else is test code
  or documentation. That is the honest shape of the audit: the accessibility work was mostly done, and
  what was missing was evidence — with exactly one real hole underneath it.
- **Violations are allowlisted after the run, never disabled inside axe.** `rules: { enabled: false }`
  produces no evidence: the rule stops reporting, and the day the markup changes nothing says so.
  Subtracting a named entry from a completed run keeps the finding visible and printed on every run.
- **`best-practice` and every AAA tag are out of scope.** They are advice rather than the conformance
  target, and a gate that fails on advice stops being read, which costs more than it buys.
- **`@axe-core/playwright` was deliberately not added.** Its advantage over injecting `axe.min.js` is
  frame traversal, and this application renders no cross-origin iframes. A dependency for a capability
  the app cannot exercise is a dependency to maintain for nothing.
- **Firefox and webkit are run against one spec path, never the whole suite.** A full serial chromium
  run is already 7–13 minutes on this host and `playwright.config.ts` pins `workers: 1`. Running a
  second engine over everything doubles that for coverage that only matters where the engines diverge.
- **No change was needed to `playwright.config.ts` or `scripts/dev-tooling.mjs`.** The config already
  declares `chromium`, `firefox` and `webkit`; the chromium-only default lives in
  `playwrightTestArguments()`, which injects `--project=chromium` only when the caller passes no
  `--project` of their own; and `mcr.microsoft.com/playwright:v1.62.0-noble` ships all three binaries.
  A `--project=firefox` run therefore works today with no new setup. Both files were left untouched.
- **Edge is not run, and the substitution is recorded rather than assumed.** Edge is Chromium-equivalent
  for everything this application uses; the `msedge` channel needs a host-installed binary the Playwright
  image does not carry; and Edge's documented divergences — its own PDF viewer, its `mica`/`acrylic`
  surfaces, WebView2 embedding — touch nothing here.
- **contenteditable is verified through the persisted note row, not the save indicator.** A synced
  collaborative session leaves autosave unbound, so the indicator is not a reliable oracle. The spec
  polls the row through the REST API instead.
- **Paste is a synthetic `ClipboardEvent` carrying a `DataTransfer` with `text/html`.**
  `grantPermissions(["clipboard-read"])` is Chromium-only, and a real OS-clipboard copy is flaky headless
  in WebKit — either would make the cross-browser spec fail for reasons that are not the application's.
- **Print is asserted under `emulateMedia({ media: "print" })` against `PRINT_HIDDEN_SELECTORS`,
  not `page.pdf()`**, which is Chromium-only and so cannot be the assertion in a cross-browser spec.
- **WebAuthn is asserted as graceful degradation, not registration.** `addInitScript` deletes
  `window.PublicKeyCredential` and the spec asserts the passkey control shows its unsupported state
  rather than throwing. Real passkey registration stays chromium-only because Playwright's virtual
  authenticator is CDP-only.
- **200% zoom is applied at 1440 px only.** Applying it at 390 px as well tests a viewport no real device
  presents and would assert a layout nobody sees.
- **`PRINT_HIDDEN_SELECTORS` moved to its own module rather than being exported from the spec.**
  Importing a `*.spec.ts` from another spec re-registers its tests in the importer.
- **`apps/web/e2e/dashboard-shell.spec.ts` was deliberately left untouched.** See its own section below.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/web/e2e/axe.ts` | Shared axe helper: injection, WCAG A/AA tag set, serious/critical filter, post-run `ACCEPTED_VIOLATIONS` allowlist that prints what it subtracts. Not a spec file. |
| `apps/web/e2e/accessibility.spec.ts` | axe scans of six surfaces plus forced-colors focus, focus order with dialog restore, and the polite-live-region non-nesting invariant. |
| `apps/web/e2e/cross-browser.spec.ts` | Engine-divergent surfaces only: contenteditable, synthetic `text/html` paste, print media, reduced motion and reflow, WebAuthn degradation. |
| `apps/web/e2e/print-selectors.ts` | `PRINT_HIDDEN_SELECTORS`, shared by `print-export.spec.ts` and `cross-browser.spec.ts`. Not a spec file. |
| `apps/web/e2e/print-export.spec.ts` | Import swapped to `print-selectors.ts`. No other change. |
| `apps/web/src/styles/globals.css` | New `@media (forced-colors: active)` block: a real `!important` `outline` on `:focus-visible`, overriding the `focus-visible:outline-none` written into 20+ component class strings. |
| `apps/web/package.json` | `axe-core` added as an exact-pinned devDependency. |
| `docs/standards/testing.md` | Delimited Part 76 section: axe scope and the allowlist rule, the two cross-browser commands, the explicit-spec-path rule, the recorded Edge substitution. |
| `docs/standards/frontend.md` | Browser-support position. |

## Database and Data Changes

None.

## API, Configuration, and Operational Changes

No route, contract, schema, environment variable, port, or feature flag changed. The only
configuration change is `axe-core` in `apps/web/package.json` as an exact-pinned devDependency, which
means **`pnpm-lock.yaml` must be reconciled by a `pnpm install` before any frozen-lockfile install or
CI run**. The version chosen, 4.12.1, is already present in the pnpm store transitively via
`eslint-plugin-jsx-a11y`, so the reconciliation adds a direct edge rather than a new artefact. It is a
devDependency and reaches no production bundle.

## Security and Tenant-Isolation Notes

No new security impact. This part adds no production code paths — the single production change is a CSS
media block that only affects rendering under forced colours. The new specs provision their identities
through `accounts.ts`, which creates per-run identities with a `randomUUID()` suffix inside the
disposable e2e database, exactly as Part 75's specs do, so the Part 75 trace-secret reasoning applies
unchanged: a trace may legitimately carry the fixture password and its session token, and must never
carry a deployment secret.

## Verification Evidence

The 2026-08-26 implement-only session executed **nothing** — that is why the rows below carry two
provenances. Everything marked **Pass** was executed later the same day by the review-remediation
session `3fb3cda0`: all five repository gates, the axe scan (which had never once run, see
"The helper could not be loaded at all" below), all three cross-browser engines, and the full chromium
baseline. Every row still marked **Not performed** is genuinely not performed and is *not* pending on a
command an agent can issue — the two screen-reader/High-Contrast rows require a human at a real
assistive-technology stack, and are recorded as named residuals rather than as work that was skipped
for convenience. Read each row's Result as the literal claim; nothing here is aspirational.

| Check | Result | Notes |
|---|---|---|
| `pnpm install` | **Pass** | Lockfile already reconciled. |
| `pnpm lint` | **Pass** | ESLint, `--max-warnings 0`, 4 packages. |
| `pnpm format:check` | **Pass** | Prettier. |
| `pnpm type-check` | **Pass** | 6 tasks. `apps/web/e2e/accounts.ts:59` had to be fixed first — it called `APIResponse.request()`, which does not exist. |
| `pnpm test` | **Pass** | web 1779 tests, api 2676, shared 448, root scripts 33. |
| `pnpm build` (with the HTTPS `NEXT_PUBLIC_*` prefixes) | **Pass** | The prefix is required: `pnpm build` validates the web environment as production and rejects the loopback values in `apps/web/.env.local`. |
| `pnpm e2e:test e2e/accessibility.spec.ts` | **Pass — 15/15** | 9/9 on the remediation session's first working run, after four defects were fixed — two of them real WCAG failures in the product (see below). Now **15/15**: the six orphaned `dashboard-shell.spec.ts` assertions were ported in and a seventh defect, a strict-mode breadcrumb locator, was fixed on their first execution. |
| `pnpm e2e:test e2e/cross-browser.spec.ts` | **Pass — 5/5** | chromium. |
| `pnpm e2e:test --project=firefox e2e/cross-browser.spec.ts` | **4 passed, 1 skipped** | The paste test is gated out on Gecko as an engine capability, with the reason recorded in the run output. See below. |
| `pnpm e2e:test --project=webkit e2e/cross-browser.spec.ts` | **Pass — 5/5** | |
| Full Playwright suite (chromium) | **Ran — 74 passed / 3 failed / 9 skipped / 4 did not run**, 9.2 min | Re-run correctly this time: on a fresh `pnpm e2e:up`, **before** any performance benchmark. The earlier attempt was invalid because it followed the benchmark, which leaves ~7,000 `pending` rows in `job_outbox` and starves the email path. Every accessibility and cross-browser test in this part passes inside it; the 3 failures are in `note-images.spec.ts` and `print-export.spec.ts` and are analysed in the **Part 75** record, not here. |
| Manual screen-reader pass | **Not performed** | Cannot be performed by an agent. Half of the Plan.md completion criterion; carried as RESIDUAL 1, which is why this part is Complete on its **automated** scope only. |
| Real Windows High Contrast Mode check | **Not performed** | The only true reproduction of the `forced-colors` defect. |
| Trace-secret grep (Part 75 procedure) | **Pass — 0 hits** | Run 2026-08-26 against a real failed-run trace; see the Part 75 record for the per-literal table. |
| Full Playwright suite (chromium) — **superseded** | **82 passed / 0 failed / 9 skipped**, twice | The 74/3/9 row above is the pre-fix baseline. Both failures it recorded were fixed afterwards (a collaboration remount race and a `Control+K` timing flake); see the Part 75 record for the two clean runs. |
| `ACCEPTED_VIOLATIONS` | **Still empty, now on evidence** | The list has now been exercised by real scans and remains empty: every finding was fixed rather than accepted. |

### The helper could not be loaded at all

`apps/web/e2e/axe.ts` opened with `createRequire(import.meta.url)`. Playwright transpiles specs to
**CommonJS** here — `apps/web` is not `"type": "module"` — so `import.meta` is a *syntax* error at run
time. It did not fail a scan; it took down collection of every spec that imported the file, with
`SyntaxError: Cannot use 'import.meta' outside a module` and then `Error: No tests found`. So
`accessibility.spec.ts` had never run, not once, and nothing in this part had ever been executed. It now
uses `require.resolve("axe-core/axe.min.js")`, which is what the transpiled module actually has.

### Two genuine WCAG 2.2 AA failures, found by the first working scan and fixed

1. **SC 2.5.8 Target Size (Minimum)** — `target-size` failed both task-list checkboxes in the editor. A
   user-agent default checkbox is about 13 × 13 CSS px, and two adjacent task items sit close enough that
   the criterion's spacing exception does not rescue either. `globals.css` now gives
   `ul[data-type="taskList"] li > label > input[type="checkbox"]` a `min-width`/`min-height` of **24px** —
   the criterion's floor, in `px` and as a minimum, because a reader who has reduced their root font size
   has not agreed to a smaller touch target.
2. **SC 2.1.1 Keyboard** — `scrollable-region-focusable` failed the task board's column strip: a
   horizontally scrolling `<div>` with no focusable descendant (which is exactly what an empty board is)
   can be reached by a pointer and by nothing else. It is now `role="region"` + `aria-label` +
   `tabIndex={0}`. **`NoteBoard.tsx` carried the byte-identical pattern and got the same fix**, even
   though no scan covers it — the sibling caller is where a fix like this rots if it is left behind.

The first of these was the finding this part's own "Suspected findings" section predicted; the second is
the one it predicted and then scoped out. Both are fixed here rather than deferred, because a detector
that finds a two-line fix and files a ticket instead is not doing its job.

### Two spec defects and one engine finding

- **A strict-mode locator violation.** `getByRole("button", { name: "Board" })` matches accessible names
  as a case-insensitive *substring*, so once the board renders it also matched "Manage board columns" and
  resolved to two elements — after the click had already worked. Now `exact: true`.
- **CSS `zoom` on the root element does nothing, so the "200% zoom" assertion was vacuous.** Measured:
  after `document.documentElement.style.zoom = "200%"`, Chromium reports computed `zoom: 1` and an
  unchanged root `clientWidth` of 1440. The assertion that followed was the 100% case run twice. Browser
  zoom scales the CSS pixel, so "1440 at 200%" is expressed as a **720 px viewport** — the same number,
  arrived at honestly, and identical in all three engines.
- **Gecko does not deliver `clipboardData` on a synthesised `ClipboardEvent`.** The constructor accepts
  it and the delivered event carries an empty one, so the application's paste handler is invoked with
  nothing to parse. There is no route around it: a real OS clipboard has no reliable headless backing
  store, and `clipboard-read` is a Chromium-only permission name. The spec now *probes* what the engine
  handed the application and states the result as a capability gate — full assertion on Chromium and
  WebKit, an explicit skip naming the engine on Firefox — rather than hiding the gap in a weaker
  assertion. The application code is engine-independent; what differs is the harness's ability to
  synthesise the input.

### axe coverage widened during remediation

- **Two `best-practice` rules are now run as a second pass**: `aria-treeitem-name` (the note tree renders
  `role="treeitem"` and is the app's primary navigation) and `aria-dialog-name` (every modal). Both are
  `serious`. They are named individually via `runOnly: { type: "rule" }` rather than by widening the tag
  list, so the rest of `best-practice` stays advisory and the exception list stays short and reviewable.
- **`incomplete` results are now projected and logged.** They were being discarded, which meant every
  *undecidable* `color-contrast` case vanished silently — and contrast is a criterion this part is
  explicitly about. They are reported, never gated, because axe is not claiming a failure; a human has to
  look. The first runs surfaced `color-contrast` as undecided on `kbd`, the editor toolbar selects, table
  cells, task-list text and several muted-foreground spans, and `aria-prohibited-attr` as undecided on a
  `.rounded-2xl` element in the dashboard shell. **These are open questions, not passes.**
- **A `null` impact now gates.** axe leaves `impact` unset when it cannot grade a finding, and reading
  "ungraded" as "harmless" is the one interpretation that can only ever hide things.

## Manual keyboard and screen-reader checks — NOT PERFORMED (named residual)

Plan.md Part 76 requires "automated axe scans **plus** manual keyboard/screen-reader checks". Only the
first half is executable here. **An axe pass is not screen-reader evidence and must never be reported as
if it were** — automated tooling detects roughly a third to a half of WCAG issues, and reading order,
announcement quality, and whether a control's name makes sense out loud are all outside what it can see.
Nothing in this record claims any screen-reader behaviour, and no automated result below should be read
as standing in for one.

**How this part is judged complete.** The manual pass requires a human at a real NVDA or VoiceOver stack;
no agent can perform it, and it does not become performable by waiting. This part is therefore scoped to
its **automated** half, which is executed and green, and the manual half is carried as an explicit named
residual with the exact procedure below — written so a human can run it without re-deriving anything —
rather than being silently claimed or left to block the record indefinitely. The residual is real and
open: **until it is run, this part's WCAG 2.2 AA conformance is asserted on automated evidence only.**

Run on two pairings, because the divergence between them is itself the finding:

- **NVDA + Firefox** (Windows)
- **VoiceOver + Safari** (macOS)

On three surfaces: the **dashboard shell**, the **note editor**, and **one open dialog**
(`CreateNoteDialog`). For each, verify:

1. **Landmark order** reads `banner` → `navigation` → `main`, and each landmark is reachable from the
   landmark rotor (NVDA `D`; VoiceOver `VO`+`U` → Landmarks).
2. **The skip link is the first focus stop** on the page, is announced when it receives focus, and
   **moves focus** when activated — not just scroll position. There are **two**, in this order, and both
   must be checked: `app/layout.tsx:56` renders **"Skip to main content"** → `#main-content` as the very
   first focus stop on every page, and `layout/DashboardShell.tsx:154` renders **"Skip to workspace
   navigation"** → `#workspace-navigation` second, inside the shell only. (Corrected 2026-08-26: this
   step previously named only the second one as "the shell's real skip link", which would send a checker
   looking for the wrong first stop.)
3. **The heading outline is sequential with exactly one `h1`** and no skipped level (NVDA `H` / `1`–`6`;
   VoiceOver rotor → Headings).
4. **The editor toolbar is announced as a toolbar**, moves by arrow key under roving tab focus with a
   single tab stop for the whole group, and **announces pressed state** for each toggle (bold, italic,
   list, and the rest) — both when pressed and when released.
5. **A dialog is announced with its accessible name** on open, **traps focus** so Tab cycles inside it,
   closes on Escape, and **returns focus to the control that opened it**.
6. **Save and status changes are announced once** through the polite live region, and **not repeatedly**
   — type, pause, and confirm the announcement does not repeat on every keystroke or on re-render.
7. **Every drag-reorder control has an announced keyboard alternative.** The Move up / Move down /
   Move to column / Move to position controls in `TaskRow.tsx`, `NoteList.tsx`, `NoteBoard.tsx` and
   `TaskBoard.tsx` must each be reachable and named clearly enough to act on without sight, and the
   resulting new position must be announced.

Record the result in this file's Verification Evidence table when it is run, naming the screen-reader
and browser versions used, and strike this section's residual status at the same time. A finding from
that pass is a **new defect against this part**, not a reopening of it.

## The `forced-colors` gap

**What was broken.** The global focus indicator was `outline-none ring-2 ring-ring`. Tailwind's `ring-*`
compiles to a `box-shadow`, and Windows High Contrast Mode **discards box-shadows outright**. Combined
with `outline-none`, that left the application with **no visible focus indicator at all** in forced
colours — a direct WCAG 2.2 SC 2.4.7 (Focus Visible) failure, and one invisible to every other test the
project runs, because every other test runs in normal colours where the ring is present and correct.

**What was added.** An `@media (forced-colors: active)` block in `apps/web/src/styles/globals.css` giving
`:focus-visible` a real `outline: 2px solid Highlight` with `outline-offset: 2px`. `outline` survives
forced colours where `box-shadow` does not, and the `Highlight` system colour is the one the user's own
high-contrast theme guarantees to be visible.

**Both declarations carry `!important`, and that is the whole reason the rule works.** The first draft of
this block did not, and would have fixed nothing: `focus-visible:outline-none` is written into more than
twenty component class strings (`ui/button.tsx`, `editor/EditorToolbar.tsx`, `notes/PageContainer.tsx`,
`notes/NoteTree.tsx`, `tags/TagFilterList.tsx`, …), and Tailwind compiles every one of them into
`@layer utilities` — a **later cascade layer** than the `@layer base` block this rule lives in, and with a
higher specificity besides. Without the flag the new rule loses to each of them and forced colours still
paints no focus ring on a single button. The alternative — rewriting `outline-none` to `outline-hidden`
in twenty-plus files — is a far larger diff that the next component to write `outline-none` silently
reopens; one forced-colors floor cannot be reopened. This was caught by reading the compiled Tailwind
output, not by running anything, and the automated assertion below is what will confirm it.

**`forced-color-adjust` was considered and deliberately not used anywhere.** The two candidates were the
Part 58/59 collaborator presence palette and the Part 72 runtime accent. Both were rejected on the same
ground: colour is not the sole carrier of meaning in either (the presence caret is always paired with a
name label, and the accent is decorative branding over surfaces that carry their own labels), and
`forced-color-adjust: none` opts an element **out of the user's own contrast choice**. For
`.notted-presence-caret-label` — white text on an inline palette background — pinning it would actively
strip legibility rather than protect it.

**How to verify it — two checks, one automated and one manual:**

1. **Automated (written, and passing):** the `emulateMedia({ forcedColors: "active" })` assertion in
   `apps/web/e2e/accessibility.spec.ts:401`, green in every run of that spec since it was first able to
   load. This proves the CSS rule applies and computes to a non-`none` outline. It does *not* prove the indicator is visible against a real high-contrast theme — Chromium's
   emulation approximates forced colours, it does not reproduce Windows' colour substitution.
2. **Manual (not performed, and the only true reproduction):** enable **Windows High Contrast Mode**
   (Settings → Accessibility → Contrast themes) and tab through the dashboard shell, the editor toolbar,
   and an open dialog in **both Edge and Firefox** — the two engines implement forced colours differently
   and Firefox is the stricter of the two. Confirm a visible focus ring on every interactive control,
   including buttons that carry a custom background.

Until check 2 is performed, the fix is *reasoned and asserted*, not *observed*.

## `dashboard-shell.spec.ts` is still dead

`apps/web/e2e/dashboard-shell.spec.ts` **is skipped in every run** and was skipped before this part too.
It gates on `PLAYWRIGHT_SHELL_EMAIL` / `PLAYWRIGHT_SHELL_PASSWORD`, which nothing in the repository sets,
and the seed writes no Better Auth credential accounts, so a seeded user cannot sign in by password even
if someone supplied the variables. Part 75 recorded it as a dead spec and left its disposition to this
part.

Its tests are **partially** superseded by `accessibility.spec.ts` and `cross-browser.spec.ts`, which
provision themselves through `accounts.ts` and therefore actually run. An earlier draft of this record
said "now superseded", full stop. That was wrong, and it was wrong in the direction that loses coverage:
**six assertions have no equivalent anywhere in the suite.**

### All six are now ported and executing — 6 of 6

The disposition chosen was the first of the two below: port them into `accessibility.spec.ts`, which
provisions itself through `accounts.ts` and therefore actually runs. **Every one of the six is now a
verified assertion instead of an unverified one**, and the spec runs 15 tests where it ran 9.

| Assertion that had no equivalent | Where it lives now | Verified |
|---|---|---|
| The breadcrumb landmark (`nav` + accessible name) | `accessibility.spec.ts` — "reflows at {phone,tablet,desktop}…" | Pass ×3 |
| The below-768 px mobile navigation dialog — open, Escape, focus restore | same test, `width < 768` branch | Pass (phone) |
| The 820 px viewport | same test, `tablet` iteration | Pass |
| `role="menuitem"` | `accessibility.spec.ts` — "exposes the user menu as a real menu with menu items" | Pass |
| Notification read-state persistence and mark-all-read | `accessibility.spec.ts` — "persists notification read state across a reload…" | Pass |
| The notification 503 path — `role="alert"`, retry, and no data leak | `accessibility.spec.ts` — "surfaces a notification failure as an alert…" | Pass |

Three things had to change to make the ported assertions honest rather than merely green:

1. **The breadcrumb locator was a strict-mode violation, found on the first run.** The workspace overview
   route renders its own `<nav aria-label="Workspace breadcrumb">` inside `main`, and Playwright's
   accessible-name match is a case-insensitive **substring**, so `{ name: "Breadcrumb" }` resolved to two
   landmarks. It is now `exact: true` and targets the shell's. (The original spec carried the loose
   locator, so this defect would have surfaced the first time it was ever allowed to run.)
2. **The mark-all-read assertion needed two notifications, not one.** With a single notification, marking
   it read already empties the badge and "Mark all read" is asserted against a control that did nothing.
   The ported test provisions a second identity, joins it to the workspace, and has it mention the owner
   in **two separate notes** — two, because the producer's idempotency key is
   `sha256(workspace, note, recipient)` and two mentions in one note collapse to one notification.
3. **The final badge assertion is `exact: true`.** The original used a substring name, which
   "Notifications, 1 unread" satisfies — so the assertion that mark-all cleared the badge could never
   have failed.

**The file was left in place, deliberately, and its deletion is now a separate and much smaller
decision.** With the six ported, its remaining assertions are each covered by a spec that runs:
the command palette and `Control+K` by `search.spec.ts:178,200`, the `"Current workspace"` combobox and
its server-validated switch by `workspace-management.spec.ts:128-152`, and `"Sign out"` by
`auth.spec.ts:51`. So nothing unique to `dashboard-shell.spec.ts` is unverified any more — which is the
condition the earlier "delete it after the first green scan" plan was actually waiting on. It is still
on disk because deleting a file is outside this remediation's scope, not because anything in it is
still load-bearing.

A claim worth correcting, because an earlier draft of this record got it wrong: the spec's
`"Skip to main content"` assertion is **not** stale. There are two skip links, contributed by two
layouts — `src/app/layout.tsx` renders `"Skip to main content"` → `#main-content` as the first child of
`<body>` for every page, and `DashboardShell` adds `"Skip to workspace navigation"` →
`#workspace-navigation` as the second. `accessibility.spec.ts` asserts both, in that order. The spec is
dead purely because of the environment gate above, and for no other reason.

**The file was deliberately left untouched**, and stays that way — see the table above for why the
"delete it after the first green scan" plan was retired.

## axe scope, stated honestly

- **Surfaces scanned:** `/login` unauthenticated, the dashboard shell, the note editor (seeded with a
  table, an image with alt text, and a task list), the tasks board/list, search results, and one open
  dialog (`CreateNoteDialog`).
- **Surfaces not scanned:** everything else, including settings, admin and audit views, the export
  flows, the AI surfaces, and the hand-rolled menus and popovers listed under Handoff Notes except where
  they happen to be open on a scanned page.
- **Tags:** `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, **plus a second pass over exactly two
  named `best-practice` rules** (`aria-treeitem-name`, `aria-dialog-name`). The rest of `best-practice`
  and every AAA tag stay excluded — advice, not the conformance target.
- **Severity:** `serious`, `critical`, **and ungraded (`impact: null`)** fail. `minor` and `moderate` are
  not gating.
- **`incomplete` is reported but never gating**, so undecidable contrast stops disappearing silently.
- **`ACCEPTED_VIOLATIONS` is empty and has now been exercised** by real scans across all six surfaces.
  Every finding was fixed rather than accepted, which is the outcome the list exists to make visible.
- **axe automatically detects roughly a third to a half of WCAG issues.** It is a floor that catches
  regressions. It is **not** a conformance claim, and a green scan on six surfaces is not a statement
  about the application as a whole.

## Suspected findings the first run is likely to surface

Named in advance so a real result is recognised as a result rather than treated as a broken spec:

- ~~**`TaskBoard.tsx` column strip.**~~ **Confirmed and fixed.** axe flagged it as
  `scrollable-region-focusable` on the `task board` scan, exactly as predicted. It was scoped out of this
  part as "the detector, not the fixes"; that scoping was dropped, because the fix is three attributes
  and leaving a predicted, confirmed SC 2.1.1 failure in place would make the detector decorative.
  `NoteBoard.tsx` got the same fix for the same pattern.
- **The forced-colors assertion is the fix's own proof.** It passes. A failure there would have been
  information about the stylesheet, not about the spec.
- **Unpredicted, and found anyway:** `target-size` on the editor's task-list checkboxes (SC 2.5.8), plus
  the three harness defects described in the Verification Evidence section.

## Already satisfied before this part — verified, not built

These were checked during the audit and needed no change. Recording them so a later part does not
re-audit them from scratch:

- **Drag alternatives.** `TaskRow.tsx`, `NoteList.tsx`, `NoteBoard.tsx` and `TaskBoard.tsx` all ship
  Move up / down / to-column / to-position controls, and all four `@dnd-kit` surfaces register a
  `KeyboardSensor` with `sortableKeyboardCoordinates`. The *announcement* quality of those controls is
  still an open manual check — see the screen-reader section, item 7.
- **Error association.** `apps/web/src/components/ui/form-controls.tsx` wires `aria-describedby`,
  `aria-invalid`, and `role="alert"` together.
- **Accessible authentication.** Correct `autoComplete` values throughout, including `one-time-code`.
- **Contrast arithmetic.** `packages/shared-validators/src/color-contrast.ts` (Part 72) is the single
  shared WCAG implementation and was not duplicated here.
- **Focus primitives.** `apps/web/src/components/editor/useRovingToolbar.ts` and
  `apps/web/src/components/editor/useDialogFocusRestore.ts` already existed; the new specs assert their
  behaviour rather than replacing them.

## Known Limitations and Follow-up Work

- **RESIDUAL 1 — the manual screen-reader pass.** **Still open, deliberately.** Re-read on 2026-08-26 by
  the residual-closure session, **not attempted and not simulated**; no screen-reader behaviour is
  claimed anywhere in this record from an axe result. The procedure was checked for followability and is
  complete — two pairings, three surfaces, seven numbered checks with the actual NVDA/VoiceOver
  keystrokes and the specific files the drag-reorder controls live in — with one correction applied to
  check 2 (the page has **two** skip links and the first is `app/layout.tsx`'s "Skip to main content").
  Not performed and not performable by an agent. The
  exact procedure is in "Manual keyboard and screen-reader checks" above: NVDA + Firefox and
  VoiceOver + Safari, three surfaces, seven numbered checks. Needs a human owner. This part is judged
  complete on its automated scope; this residual is what the automated scope does **not** cover.
- **RESIDUAL 2 — real Windows High Contrast Mode verification of the `forced-colors` fix.** **Still open,
  deliberately.** Re-read on 2026-08-26 and left standing: it needs a real Windows box with contrast
  themes on, in two browsers, and no emulation substitutes for it. The procedure below is complete enough
  to hand to a human as written; nothing was changed. Not
  performed. Procedure: Settings → Accessibility → Contrast themes, then tab the dashboard shell, the
  editor toolbar and an open dialog in **both Edge and Firefox** (Firefox is the stricter engine),
  confirming a visible focus ring on every interactive control including those with a custom background.
  The Chromium `emulateMedia({ forcedColors: "active" })` assertion that *is* green proves the CSS rule
  wins the cascade and computes to a non-`none` outline; it does **not** reproduce Windows' colour
  substitution, so it is a proxy and is recorded as one.
- ~~**Nothing here has been executed.**~~ Closed: every automated command in the Verification Evidence
  table has now run, on all three engines.
- ~~**`ACCEPTED_VIOLATIONS` is unmeasured.**~~ Closed: exercised, and still empty.
- ~~**`dashboard-shell.spec.ts`'s six unduplicated assertions are an open follow-up.**~~ **Closed** —
  all six are ported into `accessibility.spec.ts` and now execute. The file itself is still **NOT to be
  deleted** without a separate decision; see the dedicated section.
- **The undecided axe results are open questions.** `color-contrast` could not be decided on `kbd`, the
  editor toolbar selects, table cells, task-list text and several muted-foreground spans, and
  `aria-prohibited-attr` could not be decided on a `.rounded-2xl` element. axe cannot compute contrast
  over a gradient, an image, or a partly transparent background; a human has to read those. They are
  logged on every run so they cannot be forgotten.
- **The full chromium suite must not be run straight after the performance benchmark.** The benchmark
  leaves ~7,000 `pending` rows in `job_outbox`, and the email path starves behind them: 30 auth-dependent
  specs time out waiting for a verification message that arrives minutes late. `pnpm e2e:up` between the
  two, or run the browser suite first.
- **Hand-rolled menus and popovers are not individually scanned.** `SlashCommandMenu`, `MentionList`,
  `SuggestionPopover`, `ai/GrammarPopover`, `ai/TagSuggestions`, `layout/NotificationCenter`,
  `layout/WorkspaceSwitcher`, and `tags/TagPicker` are all bespoke — the only Radix primitive installed
  is `@radix-ui/react-dialog`. Bespoke menu widgets are exactly where `aria-activedescendant`, roving
  focus, and Escape handling drift, and axe will not see a menu that is closed when the page is scanned.
  A per-widget pass is worth a follow-up.
- **Edge is covered by substitution, not by execution.** Recorded in `docs/standards/testing.md`; revisit
  the day one of Edge's divergent surfaces becomes load-bearing.
- **The cross-browser spec asserts WebAuthn *degradation*, not registration**, under firefox and webkit.
  Real passkey registration remains chromium-only for as long as Playwright's virtual authenticator is
  CDP-only.

## Handoff Notes

- **`apps/web/e2e/axe.ts` must not use `import.meta`.** Playwright transpiles these specs to CommonJS, so
  `import.meta` is a syntax error that takes down collection of every importing spec — not a runtime
  failure in one scan. Use `require.resolve`.
- **`axe-core@4.12.1` is reviewed in ADR 0008** ("Part 76 accessibility-tooling dependency review"):
  devDependency only, MPL-2.0, zero transitive dependencies, absent from the production graph and
  therefore absent from the `THIRD-PARTY-NOTICES.md` copyleft sweep.
- **`docs/standards/testing.md` uses HTML delimiters.** This part's block is
  `<!-- BEGIN Part 76 -->` / `<!-- END Part 76 -->`, appended *below* Part 75's block. Part 78 appends
  below this one.
- **`apps/web/e2e/axe.ts` and `apps/web/e2e/print-selectors.ts` are not spec files and must stay that
  way.** Renaming either to `*.spec.ts` makes Playwright collect it as a zero-test file; importing
  `print-export.spec.ts` directly would re-register its tests in the importer.
- **Never disable an axe rule to make a run pass.** Add a rationale to `ACCEPTED_VIOLATIONS`, which
  prints on every run, so the finding stays visible.
- **Never run both Compose stacks at once.** `e2e` is a profile inside the same project:
  `pnpm infra:down`, then `docker compose --profile e2e build api-e2e` as its own foreground step, then
  `pnpm e2e:up`. Reverse it to get back to development.
- **Playwright stays at one worker.** `workers: 1` / `fullyParallel: false` in
  `apps/web/playwright.config.ts` is a standing invariant on this host, not a default to tune. It is also
  why the firefox and webkit runs take a spec path.
- **Stage the browser runs.** The two new specs first, whole suite second. A full serial run is 7–13
  minutes, so finding a broken new spec at minute 9 is avoidable.
- **Re-run a failing spec alone before calling it a defect.** This suite is load-sensitive here; a spec
  that passes in isolation and fails only under a full run is contention. Never a bare retry, a sleep, or
  a weakened assertion.
- **Do not "fix" a cross-browser failure by reaching for a Chromium-only API.** Every avoidance in that
  spec — synthetic paste over `grantPermissions`, `emulateMedia` over `page.pdf()`, degradation over
  virtual authenticator — exists because the Chromium-only version passes in chromium and fails
  everywhere else, which is the opposite of what the spec is for.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-26 | Claude Code implementation session | Initial record. Implement-only; no gate, no test, no browser, no screen reader run. |
| 2026-08-26 | Review-remediation session `3fb3cda0` (second pass) | Corrected the Verification Evidence preamble, which still read "Nothing in this part has been executed" directly above a table of Pass results. **Ported all six orphaned `dashboard-shell.spec.ts` assertions into `accessibility.spec.ts`** (9 tests → 15), fixing a strict-mode breadcrumb locator, provisioning two mention notifications so "Mark all read" is not asserted against a control that did nothing, and making the cleared-badge assertion `exact` so it can actually fail. Ran the full chromium baseline correctly, on a fresh `e2e:up` before the benchmark. Ran the Part 75 trace-secret grep. **State flipped to Complete on the automated scope**, with the manual screen-reader pass and the real High Contrast Mode check recorded as named residuals rather than as blockers or as silent claims. |
| 2026-08-26 | Review-remediation session `3fb3cda0` | First execution of anything in this part. Fixed the `import.meta` load failure that had kept every scan from running, fixed two genuine WCAG 2.2 AA failures (`target-size` on task-list checkboxes, `scrollable-region-focusable` on both boards), fixed a strict-mode locator and a vacuous CSS-`zoom` assertion, added a measured engine-capability gate for Gecko clipboard events, widened axe to two named best-practice rules, made `incomplete` visible and `null` impact gating, and corrected the `dashboard-shell.spec.ts` supersession claim. **State stays In progress:** the manual screen-reader pass, which is half the Plan.md criterion, still cannot be performed by an agent. |
| 2026-08-26 | Residual-closure session `3fb3cda0` | Reviewed both manual residuals for followability and **left both standing**: neither was attempted, neither was simulated, and no screen-reader or forced-colors behaviour is claimed from an automated result. One correction to RESIDUAL 1's check 2 — it named `DashboardShell.tsx`'s "Skip to workspace navigation" as the shell's skip link, but `app/layout.tsx:56` renders "Skip to main content" first on every page, so a checker following the old text would have looked for the wrong first focus stop. No other change to this part. |
