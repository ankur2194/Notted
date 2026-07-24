# Part 06 — Create Shared Types and Validators

## Status

- **State:** Complete
- **Completed on:** 2026-07-24
- **Implemented by:** `/root/lead_part_engineer_part6`
- **Plan reference:** `Plan.md`, Part 6
- **Related records:** `part-01-architecture-decisions.md`; `part-02-monorepo-initialization.md`; `part-03-formatting-linting-commit-gates.md`; `part-04-nextjs-web-scaffold.md`; `docs/decisions/0001-monorepo-boundaries.md`; `docs/decisions/0002-api-boundary.md`

## Objective

Provide stable, framework-neutral public contracts for Notted's applications and strict shared Zod input schemas. The packages establish safe transport shapes for later API and frontend work without pre-implementing persistence, authentication, editor, storage, or authorization behavior.

## Implemented Work

- Expanded `@notted/shared-types` into root-barrel exports for JSON-safe values, ISO timestamps, identifier aliases, bounded pagination metadata, sorting, discriminated API responses, validation issues, and safe user, workspace, project, note, attachment, search, and standalone-task summaries/details.
- Expanded `@notted/shared-validators` into root-barrel exports for common primitives and strict create/update/filter operations across user profiles, workspaces, projects, note metadata, attachment intents, search, and standalone tasks.
- Added exact `zod@4.4.3` runtime ownership to the validator package manifest. The shared package remains CommonJS with declaration output.
- Added package tests for valid, invalid, boundary, defaulting, query-coercion, unknown-key, empty-update, date-order, JSON-recursion, and forbidden-field behavior.
- Added the web application's direct workspace dependency on both shared packages, production-root imports, required Next transpilation, and a web contract smoke test.

## Important Decisions

- Public response envelopes are `{ success: true, data, requestId }` and `{ success: false, error: { code, message, details? }, requestId }`. Error details are JSON-safe and validation issues expose only path, code, and safe message.
- Pagination defaults to page `1`, limit `25`, and maximum `100`. Query schemas accept only canonical unsigned decimal strings for numbers and exact lower-case `"true"`/`"false"` strings for booleans. Body schemas do not coerce.
- All objects are strict, updates reject empty bodies, and filters constrain sort fields. Client-supplied workspace/resource identifiers are selectors only and never authorization.
- Contracts intentionally exclude database rows, Better Auth credentials/provider/session state, TipTap/Yjs documents, embeddings, object keys, buckets, remote asset URLs, signed URLs, and binary `File`/`Blob` objects.
- User profile contracts contain display/account metadata but no account-registration or credential operations. Attachment contracts contain upload intent and display metadata only.
- The task contract anticipates the first-class standalone task model required by ADR 0007 and Part 17; it does not define persistence constraints or inline TipTap checklist conversion.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/` | Framework-neutral domain/output contracts and stable public barrel. |
| `packages/shared-validators/src/` | Strict Zod schemas, inferred input types, and validator behavior tests. |
| `apps/web/src/lib/shared-contracts.ts` | Web transport-boundary adapter proving production imports from both package barrels. |
| `apps/web/src/lib/shared-contracts.test.ts` | Workspace-resolution and shared-pagination smoke coverage. |
| `apps/web/package.json`, `apps/web/next.config.js` | Direct validator dependency and production transpilation declaration. |

## Database and Data Changes

None. These are transport contracts, not database schemas or migrations.

## API, Configuration, and Operational Changes

- Adds the shared API response/error, pagination, sort, and resource input/output contracts that later tRPC and REST adapters may consume.
- No route, environment variable, port, migration, queue, external service, or deployment behavior is added.
- `pnpm-lock.yaml` was intentionally not modified during parallel initial implementation. Central integration must update it and verify frozen strict installation.
- API application consumption remains a central-integration follow-up because this agent was explicitly prohibited from modifying `apps/api`.

## Security and Tenant-Isolation Notes

- Shared identifiers do not establish authorization; NestJS services and policies must prove actor, workspace, and resource scope.
- Strict schemas reject unknown/mass-assignment fields including roles, plans, creators, storage keys, signed URLs, credentials, embeddings, and provider state.
- No shared contract contains a secret or private object-store locator. Validation errors must not echo rejected values.
- No runtime authorization or tenant-isolation behavior is introduced by this part; those remain backend invariants in later parts.

## Verification Evidence

The coordinating parent reconciled the implementation and ran focused and broad verification on 2026-07-24.

| Check | Result | Notes |
|---|---|---|
| Shared-types unit tests | Pass | 1 file and 3 tests passed; CI coverage reported 100% for executable barrel code. |
| Shared-validators unit tests | Pass | 2 files and 28 boundary/strictness tests passed; aggregate coverage exceeded every 70% threshold. |
| API shared-contract smoke test | Pass | The API production adapter test passed as part of the 26-test API suite. |
| Web shared-contract smoke test | Pass | Included in the full web suite: 14 files and 50 tests passed. |
| Package/web format and lint | Pass | Repository formatting passed. A current lint run passed all four workspaces; the unchanged root-config self-check had passed earlier and stalled only on the final duplicate run. |
| Strict type-check and declaration builds | Pass | `pnpm type-check` passed 6 tasks; `pnpm build` produced both shared package declarations and both applications. |
| Frozen strict install | Pass | The lockfile resolves with `--frozen-lockfile --strict-peer-dependencies`. |
| Diff and contract review | Pass | Reviewed strict bodies, selector-only workspace identifiers, JSON-safe errors, safe attachment metadata, `in_progress` task status, root-barrel-only imports, and absence of provider/persistence secrets. |

## Known Limitations and Follow-up Work

- The packages define transport contracts, not authorization. Later backend services must continue proving actor, workspace, and resource scope rather than trusting shared identifiers.
- The full root coverage command remains locally environment-limited by web jsdom worker startup on the mounted Windows filesystem; the ordinary 50-test web suite and both shared-package coverage suites pass, and Part 7 retains hosted CI proof as a blocker.
- Authorization, cross-tenant resource validation, database constraints, TipTap/Yjs content validation, signed-download issuance, and Better Auth account inputs belong to their later numbered parts.

## Handoff Notes

- Consumers import only `@notted/shared-types` and `@notted/shared-validators`; package-internal module paths are not public API.
- Keep validator query coercion narrow. Do not replace it with broad `z.coerce.boolean()` or body coercion.
- When adding a new persisted field later, expose it here only if it is safe and required across an application boundary; persistence/provider shapes must remain internal.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-24 | `/root/lead_part_engineer_part6` | Initial parallel implementation; verification intentionally deferred to the Phase 1 coordinator. |
| 2026-07-24 | `/root` | Reconciled API/web consumption, corrected contract boundaries, passed focused and broad verification, and marked Part 6 complete. |
