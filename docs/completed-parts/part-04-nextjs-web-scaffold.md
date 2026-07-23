# Part 04 — Scaffold the Next.js Web Application

## Status

- **State:** In progress
- **Last revised:** 2026-07-23 (React 19, Turbopack, accessibility, and test remediation)
- **Implemented by:** `lead-part-engineer` with `frontend-editor-engineer`
- **Plan reference:** `Plan.md`, Part 4
- **Related records:** `part-03-formatting-linting-commit-gates.md`; `part-02-monorepo-initialization.md`; `part-01-architecture-decisions.md`; `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Replace the `apps/web` placeholder with the bounded Part 4 Next.js 16 App Router scaffold: strict TypeScript, Tailwind CSS 4, root/error/loading/not-found UI, `/` and `/login`, authentication and dashboard route groups, accessible Shadcn primitives, and minimal client islands. Part 4 introduces no authentication, API, persistence, tenant, editor, or later-route behavior.

## Implemented Work

- Next.js `16.2.11`, React/React DOM `19.2.8`, App Router, `src/` layout, metadata, global Tailwind CSS, skip link, and route-group layouts.
- `/` remains the intentionally public dashboard placeholder. Its only interactive island is a small Radix Dialog/Sonner notification preview; it has no note input, delay, loading state, or persistence claim.
- `/login` is wholly server-rendered scaffolding. Credential and OAuth controls are labeled, disabled, and associated with an explicit notice that Part 22 owns authentication. It has no client state, timer, submission handler, or simulated error.
- Root route children and the Sonner-only toaster boundary render as siblings. Remaining production internal navigation uses `next/link`; the deliberately unknown-route CTA was removed.
- The client error boundary retains `reset()`, renders a real `/` link, and logs only a fixed diagnostic label plus the optional Next digest. It never logs supplied messages, causes, stacks, or error objects.
- Dialog content is narrow-width safe, viewport bounded, and vertically scrollable. Reduced-motion and visible-focus behavior remain in global CSS.
- Success, warning, and muted semantic token pairs meet WCAG AA normal-text contrast. The muted foreground was corrected from `#64748b` to `#475569`, raising the actual `#f1f5f9` muted pair from 4.3439:1 to approximately 6.917:1; a deterministic contrast regression test covers all three pairs.
- Dialog tests cover accessible name/description, initial focus, Tab and Shift+Tab containment, Escape and explicit dismissal, focus restoration, preview-action dismissal, and the exact toast call.
- Sonner is no longer globally mocked. The dialog suite uses a local toast spy and a real toaster integration test asserts notification text and its polite live region.
- Error, login, route, layout, loading, not-found, skip-link, Server Component boundary, and semantic-contrast coverage was added or corrected. The suite now contains 13 files and 49 tests; the prior integrated run passed 48/48, and the subsequently expanded semantic-token file passed its focused 3/3 run.

## Dependency and Build Decisions

- Exact React 19-compatible remediation pins:
  - `@radix-ui/react-dialog@1.1.21`
  - `@radix-ui/react-slot@1.3.1`
  - `@testing-library/react@16.3.2`
  - transitive `react-remove-scroll@2.7.2`
- `react-remove-scroll` is not declared directly and no peer override was added. `pnpm install --frozen-lockfile --strict-peer-dependencies` passes.
- Tailwind `4.3.3`, `@tailwindcss/postcss@4.3.3`, and PostCSS `8.5.22` are web development dependencies. Unnecessary `autoprefixer` was removed.
- `dev` and `build` use standard `next dev` and `next build`. `next.config.js` now contains only strict mode and required `@notted/shared-types` transpilation.
- The default Next build uses Turbopack and passes. During remediation, Turbopack exposed a real Server Component boundary error: the disabled login scaffold imported the upgraded Radix Slot through the shared Button. Native server-rendered buttons removed that invalid import while preserving the required non-interactive UI.
- No ADR was needed: the standard Next/Tailwind path is compatible after correcting the import boundary.

## Important Boundaries

- Public routes remain `/` and `/login`; unknown paths use the existing not-found UI.
- No APIs, shared contracts, schemas, environment variables, middleware, authentication, database changes, migrations, tenant identifiers, React Query, Zustand, editor behavior, or deployment contracts were introduced.
- Server Components remain the default. Client boundaries are limited to the Dialog preview, Sonner toaster, and the required Next error boundary.
- Tailwind remains CSS-first through `src/app/globals.css`; no legacy Tailwind config was introduced.

## Security and Accessibility Notes

- The scaffold handles no credentials or persisted data; all login controls are disabled and point to the Part 22 availability notice.
- Error rendering and console arguments were tested to exclude supplied sensitive message, cause, and stack content.
- Automated coverage validates semantics, dialog keyboard behavior, focus restoration, polite toast announcement structure, route landmarks, skip-link target, and AA contrast tokens.
- Required manual browser checks have not been performed in this remediation session: keyboard operation, visible focus, dialog focus containment/restoration, toast announcement, reduced motion, 320 px layout, 200% zoom, and short-viewport dialog scrolling. This keeps the record non-complete.

## Verification Evidence

All commands were run from the repository root on 2026-07-23.

| Check | Result | Notes |
|---|---|---|
| `pnpm install --no-frozen-lockfile` | Pass | Regenerated the lockfile for the exact remediation set. |
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Pass | Lockfile reproducible; no strict peer error or override. |
| `pnpm --filter @notted/web format:check` | Pass | Prettier check passed. |
| `pnpm --filter @notted/web lint` | Pass | ESLint passed with zero warnings. |
| `pnpm --filter @notted/web type-check` | Pass | Strict TypeScript check passed. |
| `pnpm --filter @notted/web test` | Pass | Final integrated run: 13 files, 48 tests. |
| `pnpm --filter @notted/web exec vitest run src/app/globals.test.ts --pool=forks --maxWorkers=1` | Pass | Post-review focused run: 1 file, 3 tests, including the actual muted/muted-foreground pair. |
| `pnpm --filter @notted/web build` | Pass | Default `next build`; Next 16.2.11 reported Turbopack and generated `/`, `/_not-found`, and `/login` statically. |
| Production HTTP smoke | Pass | `/` = 200, `/login` = 200, unknown route = 404; expected content present; compiled CSS = 200 `text/css`. |
| `pnpm audit --audit-level high` | **Fail** | Two high transitive advisories under pinned Next 16.2.11: `sharp <0.35.0` (`GHSA-f88m-g3jw-g9cj`) and Next's bundled `postcss <=8.5.11` (`GHSA-6g55-p6wh-862q`). One moderate advisory also reported. No unvalidated override was added. |
| `pnpm format:check` | Pass | All workspaces and root files passed. |
| `pnpm lint` | Pass | All workspace and root lint tasks passed. |
| `pnpm type-check` | Pass | Five tasks passed. |
| `pnpm test` | Pass | Five tasks passed; web 48/48 and shared-types 1/1. |
| `pnpm build` | Pass | Four tasks passed; web used the default Turbopack production path. |
| Manual browser accessibility checklist | **Not run** | Browser/manual assistive verification remains required. |

The first attempted root format/lint/type-check calls failed only because the read-only sandbox prevented Turborepo log writes. Each command was rerun with the required filesystem permission and passed; the table records the conclusive runs.

## Unresolved Completion Blockers

1. Resolve or formally re-evaluate the two high-severity transitive advisories while retaining a validated Next/React compatibility baseline; rerun `pnpm audit --audit-level high`.
2. Perform and record all required manual browser accessibility checks.
3. After either dependency resolution changes or manual remediation changes, rerun the relevant focused and broad gates before changing this record to `Complete`.

The Part 5 API build remains its existing placeholder and is outside Part 4.

## Handoff Notes

- Keep `next dev` and `next build` on the default path; do not restore blanket Webpack or native-module fallbacks.
- Keep the login preview server-rendered and disabled until Part 22.
- Keep the dashboard preview free of note creation or persistence semantics; real dashboard work belongs to Part 25.
- `apps/web/components.json` remains the Shadcn configuration and `@/*` maps to `apps/web/src/*`.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-23 | `lead-part-engineer` | Initial Part 4 scaffold and verification record. |
| 2026-07-23 | `frontend-editor-engineer` | Earlier Server Component and behavioral-test remediation. |
| 2026-07-23 | `lead-part-engineer` with `frontend-editor-engineer` | React 19 dependency, default Turbopack, client-boundary, accessibility, safe-logging, and test remediation. Status corrected to `In progress` because the audit fails at high severity and required manual browser checks were not run. |
| 2026-07-23 | `lead-part-engineer` with `frontend-editor-engineer` | Corrected the muted semantic pair to 6.917:1, added direct deterministic coverage, and reran focused formatting, lint, type-check, token tests, and the default production build. Audit and manual-browser blockers remain unchanged. |
