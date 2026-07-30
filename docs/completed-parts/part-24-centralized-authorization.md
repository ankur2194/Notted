# Part 24 — Implement centralized authorization

## Status

- **State:** Complete with follow-up
- **Completed on:** 2026-07-31
- **Implemented by:** Phase 4 Part 24 implementation agent
- **Plan reference:** `Plan.md`, Part 24
- **Related records:** Parts 14–23; ADRs 0002, 0003, 0007, 0009, and 0010;
  `docs/authorization.md`

Implementation and required verification are complete. Historical statements below describing
checks as not run reflect the initial implementation-only session and are superseded by the
completion update near the end of this record.

## Objective and implemented work

Part 24 adds the canonical deny-by-default authorization authority under
`apps/api/src/authorization/`. It separates authentication from authorization, proves live user
membership before establishing tenant context, scopes every resource loader through active
`TenantContext`, and evaluates owner/admin/editor/viewer behavior plus project, note, comment,
export, integration, file, task, and session rules in one framework-neutral policy.

Implemented artifacts include:

- closed actor, action, resource, decision, denial, delegation, and authorized-operation contracts;
- `AuthorizationPolicyService` with action/resource compatibility, fact freshness, role matrix,
  recent-authentication gates, project inheritance/restriction, creator/share rules, delegation
  caps, export requester/source checks, file-through-note rules, and default denial;
- `AuthorizationRepository` with exact membership bootstrap and direct/constrained-parent loaders
  for workspaces, members, projects, notes, comments, exports, API keys, webhooks, attachments,
  folders, and tasks, including target membership and cross-workspace tag checks;
- `AuthorizationEntryService`, which establishes tenant scope only after live membership proof,
  rechecks user-job authority, and models API-key/system authority without browser credentials;
- framework-neutral HTTP/REST, tRPC, Socket join/message, file, API-key, user-job, and system-job
  adapters that all invoke the same policy sequence;
- opt-in Nest `@RequireAuthorization`, guard, interceptor, request context, and safe HTTP mapping.
  Nothing is registered globally, so health and auth routes remain public as designed;
- table-driven policy tests, adapter contract tests, and a `DATABASE_URL`-gated deterministic
  Alpha/Beta integration suite. All are authored and unexecuted;
- `docs/authorization.md` with the matrix, invocation contract, tenant boundaries, transport/job
  obligations, freshness/error behavior, and future ownership.

## Important decisions

- A workspace UUID is only a selector. For a user actor, the exact current membership pair is the
  sole tenant bootstrap query; resource loading starts only inside the resulting context.
- Unknown action/resource pairs, stale facts, invalid two-hop relations, missing membership, and
  missing tenant context fail closed. Cross-tenant/missing resources are concealed as `404`.
- Owner/admin bypass restricted-project grants by policy. Editors/viewers require explicit access
  to restricted projects. Note shares never broaden the project cap.
- Editors can edit creator-owned or explicitly editable notes, but cannot gain admin/destructive
  privileges. Viewers can read and comment where project/note access permits and mutate only their
  own comments.
- System authority is a named finite capability. User jobs carry identifiers and recheck live
  membership/resource access; reusable browser credentials are never job authority.
- API-key authentication remains Part 61. Part 24 accepts only the server-authenticated,
  workspace-bound actor and applies stored scopes through the shared policy.
- No schema changed and no migration was added.

## Files and components

| Path | Purpose |
|---|---|
| `apps/api/src/authorization/authorization.contracts.ts` | Stable actors, actions, resources, decisions, selectors, and delegation contracts |
| `apps/api/src/authorization/authorization-policy.service.ts` | Canonical framework-neutral role/resource policy |
| `apps/api/src/authorization/authorization.repository.ts` | Live membership and tenant-scoped direct/parent resource facts |
| `apps/api/src/authorization/authorization-entry.service.ts` | Membership proof, context establishment, loading, policy invocation |
| `apps/api/src/authorization/authorization-adapters.service.ts` | Shared current/future transport, file, API-key, and job entry adapters |
| `apps/api/src/authorization/authorization-http.*` | Thin opt-in Nest decorator/guard/interceptor/request integration |
| `apps/api/src/authorization/authorization.module.ts`, `index.ts` | DI wiring and public backend exports |
| `apps/api/src/auth/auth.module.ts`, `auth.controller.ts` | Routes current-user session controls through the shared policy while retaining Part 23 ownership checks |
| `apps/api/src/authorization/*.test.ts` | Table policy and adapter contract tests (not run) |
| `apps/api/test/authorization.integration.test.ts` | Gated Alpha/Beta PostgreSQL authorization/isolation tests (not run) |
| `apps/api/src/app.module.ts` | Imports `AuthorizationModule` without global route protection |
| `docs/authorization.md` | Policy and future integration contract |
| `docs/completed-parts/README.md` | Adds pending Part 24 index row |

## Database, API, and operational changes

There is no schema, migration, seed, dependency, environment variable, port, queue, or object-store
change. Existing tenant tables are read through Drizzle using ADR 0009 scope helpers.

No CRUD route or future transport was fabricated. The only API runtime wiring is the imported
module and opt-in Nest authorization infrastructure. Later controllers explicitly apply the
decorator; future tRPC, Socket.io, workers, and file services call the exported adapters.

## Security and tenant-isolation notes

- Current PostgreSQL membership and grants are loaded for each entry. Previous decisions and
  authenticated sessions do not cache workspace authority.
- Direct loaders include `whereWorkspace`/`whereWorkspaceId`; comments and files resolve through
  constrained notes. Attachment/note scope, target memberships, project restrictions, and
  note/task tag scope are server-proven.
- Principal/rate-limit identity remains authentication output. Neither is a role or permission.
- Decisions contain safe audit categories without content, secrets, credentials, signed URLs, or
  raw resource IDs. Part 71 owns durable audit storage/UI.
- Recent authentication uses the Part 23 `isFresh` contract and does not infer stronger assurance.

## Authored verification (not run)

| Check | State | Notes |
|---|---|---|
| Table-driven policy suite | Not run | Covers every catalog action for every workspace role plus restrictions, shares, comments, exports, files, jobs, scopes, freshness, and denial |
| Adapter contract suite | Not run | Covers HTTP/REST, tRPC, Socket join/message, files, API keys, user jobs, system jobs, exact shared policy delegation, and bounded context |
| PostgreSQL integration suite | Not run | Gated deterministic Alpha/Beta membership changes, revocation, probes, parent scope, share/project conflict, two-hop assignments/tags, and read/write authorization |
| Lint/format/type-check/build/audit/migration checks/review/final diff | Not run | Prohibited by implementation-only instruction |

## Known limitations and follow-up

- Parts 21–24 are unverified and may contain compile, DI, Drizzle query, runtime, or contract
  defects. Verification must begin with the existing Part 21–23 prerequisites, then focused Part
  24 tests and broad safe gates.
- Parts 26–32 and later services must wire the adapters around their application services and
  transactions. They must not duplicate role/resource rules in transports.
- Part 25 may derive presentation flags, but no client flag is accepted as authorization input.
- API-key credential verification, actual exports/files, Socket/tRPC transports, workers, and audit
  persistence remain with their numbered owning parts.

## Completion Verification Update

- Two independent review rounds completed; authorization narrowing, transport consistency, and
  tenant-isolation findings were remediated before the lead completion review.
- The 242-case policy matrix, adapter tests, and live Alpha/Beta PostgreSQL integration passed,
  including membership revocation, guessed IDs, parent scope, and cross-tenant denial.
- Repository formatting, lint, strict type-check, Drizzle consistency, full tests, and production
  build passed. Track the reviewed transitive advisories in Part 21.

## Revision history

| Date | Author | Change |
|---|---|---|
| 2026-07-30 | Phase 4 Part 24 implementation agent | Authored centralized policy, scoped loaders, adapters, Nest integration, tests, and docs; verification remains pending by instruction. |
| 2026-07-31 | Lead part engineer | Completed review remediation, live tenant-isolation verification, and broad gates; marked Complete with follow-up. |
