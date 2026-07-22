# Part 01 — Record architecture decisions and resolve specification gaps

## Status

- **State:** Complete
- **Completed on:** 2026-07-22
- **Implemented by:** `/root/part1_lead` with backend and quality specialists
- **Plan reference:** `Plan.md`, Part 1
- **Related records:** `docs/decisions/0001-monorepo-boundaries.md` through `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Establish durable architecture boundaries and conservative defaults before creating the monorepo or application code, so later parts share one model for ownership, tenancy, persistence, integration, and package compatibility.

## Implemented Work

- Added eight accepted ADRs covering the monorepo, API transports, authentication, collaboration, object storage, background workers, missing schema areas, and the runtime/package baseline.
- Resolved tRPC as the first-party interface and versioned REST as the public integration interface over the same NestJS services and policies.
- Made Better Auth the sole end-user credential/session authority and PostgreSQL the durable auth source, with no parallel custom JWT/refresh-token system.
- Defined Yjs merge authority, Socket.io transport/presence ownership, PostgreSQL persistence, and TipTap projections.
- Defined private MinIO binary storage backed by authoritative, workspace-scoped PostgreSQL metadata.
- Defined post-commit PostgreSQL job intent/outbox dispatch to idempotent BullMQ workers.
- Assigned explicit deny-by-default behavior to all eleven schema gaps named in Part 1.
- Recorded exact evaluated runtime and core package versions, upstream evidence, the TipTap UI caveat, an explicit Drizzle ORM deviation required by Better Auth, and the executable validation required when runnable package parts begin.

## Important Decisions

- PostgreSQL is authoritative for durable business, auth, document, object-metadata, and job-intent state. Redis, search indexes, queue state, and presence are disposable or rebuildable.
- Authentication never implies workspace access; all transports and jobs reuse backend policies that prove tenant and resource scope.
- Public sharing, AI, webhook delivery, and object access are disabled/private until explicitly configured and authorized.
- The evaluated baseline keeps NestJS 10 and headless TipTap 2 while explicitly moving Drizzle ORM from `Notted.md`'s `0.30.x` line to `0.45.2`, the minimum stable line accepted by Better Auth `1.6.24`'s adapter.
- The Drizzle ORM line is a material, documented dependency deviation; no deviation from the canonical `Notted.md` directory structure was introduced.

## Files and Components

| Path | Purpose |
|---|---|
| `docs/decisions/0001-monorepo-boundaries.md` | Workspace layout, dependency direction, and shared-contract ownership. |
| `docs/decisions/0002-api-boundary.md` | tRPC/REST roles and common NestJS service/policy flow. |
| `docs/decisions/0003-authentication-ownership.md` | Better Auth authority, sessions, principals, and API-key distinction. |
| `docs/decisions/0004-collaborative-document-authority.md` | Yjs/Socket.io/PostgreSQL ownership and recovery semantics. |
| `docs/decisions/0005-private-object-storage.md` | PostgreSQL metadata and private MinIO binary lifecycle. |
| `docs/decisions/0006-background-workers.md` | Durable intent, BullMQ delivery, idempotency, and worker safety. |
| `docs/decisions/0007-schema-gaps-and-safe-defaults.md` | Required missing models and conservative product defaults. |
| `docs/decisions/0008-runtime-and-package-compatibility.md` | Exact evaluated versions, strict resolution evidence, explicit Drizzle deviation, caveats, and upgrade policy. |
| `docs/completed-parts/README.md` | Part history index. |

## Database and Data Changes

None. This part documents models and invariants for later schema parts; it creates no schema or migration.

## API, Configuration, and Operational Changes

No runtime routes, configuration, ports, or deployments were created. ADRs define future `/api/v1`, tRPC, Better Auth, Socket.io/Yjs, MinIO, and BullMQ boundaries. Node `22.23.1` and pnpm `10.34.5` are the evaluated baseline to be pinned in Part 2.

## Security and Tenant-Isolation Notes

Every tenant-owned operation must prove workspace membership and resource scope in reusable backend policies. Object keys, room names, payload workspace IDs, sessions, and raw UUIDs are never authority. Private storage, redacted payloads/logs, encrypted provider secrets, expiring grants/tokens, signed webhooks, and cross-workspace negative tests are specified for their implementing parts.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `git diff --check` plus direct whitespace/EOF scan | Pass | The working-tree diff passed. Because repository index state does not represent all current ADR content, a separate direct trailing-whitespace and EOF scan covered every ADR and completion record. |
| `python3` ADR gate (sequential filenames, required sections, and required Part 1 terms) | Pass | Found exactly eight sequential ADRs and every required boundary, schema gap, and named compatibility component. |
| `rg -n 'TODO|TBD|PLACEHOLDER|changeme|password\\s*[:=]|secret\\s*[:=]' docs/decisions` | Pass | No placeholder or credential-like ADR content found. |
| Backend dependency/auth assessment using `$notted-backend-data` | Pass | Confirmed no viable stable Better Auth release with verified Drizzle ORM `0.30.x` support and recommended the minimum compatible stable baseline. |
| Live npm registry metadata inspection | Pass | Better Auth `1.6.24` and `@better-auth/drizzle-adapter@1.6.24` require Drizzle ORM `^0.45.2`; Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, and `pg` `8.22.0` are stable exact selections. |
| Strict disposable dependency resolution | Pass | pnpm `10.34.5` with strict peer checks rejected Better Auth `1.6.24` plus Drizzle ORM `0.30.10` with `ERR_PNPM_PEER_DEP_ISSUES`, then resolved Better Auth `1.6.24`, Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, and `pg` `8.22.0` without peer errors (125 packages). |
| Final full `$notted-quality-operations` review | Pass | Independent review found no critical, high, medium, or low findings and no blocker to Part 1 completion. |
| Application type-check, tests, and build | Not applicable | Part 1 contains documentation only and no runnable application source. |

## Known Limitations and Follow-up Work

- Part 12 must validate Drizzle ORM `0.45.2` schema APIs, migration generation, and PostgreSQL behavior; Parts 13 and 21 must validate Better Auth `1.6.24` adapter schema and runtime behavior. The Part 1 strict install proves dependency resolution, not those later executable behaviors.
- Part 2 must pin the ultimately accepted Node/pnpm versions and prove strict dependency resolution in the real lockfile.
- Parts 4, 5, 21, and 33 must run production builds and focused Next/React, Nest, Better Auth, and TipTap smoke tests before accepting their package sets.
- Detailed table shapes, retention periods beyond explicit defaults, Yjs compaction thresholds, and queue operational tuning belong to their named later parts.

## Handoff Notes

Part 2 must treat the accepted ADRs as constraints, including the explicit Drizzle ORM deviation, preserve the canonical roots in `Notted.md`, and record any exact patch update with fresh engine/peer evidence. Later implementations must not make Redis, MinIO paths, queue payloads, Socket.io rooms, or client-supplied workspace IDs an authorization source.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-22 | `/root/part1_lead` | Initial record, originally marked complete after the first review and documentation gate. |
| 2026-07-22 | `/root/part1_handoff` | Corrected status to in progress after independent review identified a high Better Auth/Drizzle compatibility blocker, two specification conflicts, and incomplete untracked-file coverage by `git diff --check`. |
| 2026-07-22 | `/root/part1_handoff` | Resolved the compatibility blocker through an explicit Drizzle ORM deviation and strict install proof; restored the folder-depth and export-lifetime requirements and corrected whitespace coverage. |
| 2026-07-22 | `/root/part1_handoff` | Marked complete after the final full independent review returned with no findings or completion blocker. |
