# Centralized authorization

Part 24 establishes one backend authorization authority under
`apps/api/src/authorization/`. Authentication proves an actor; authorization separately loads
current workspace membership and server-owned resource facts. A cookie, API key, job payload,
workspace UUID, room name, object key, or client permission flag is never authority by itself.

## Canonical contracts

- `AuthorizationActor` has three explicit variants: a minimal user projection, a workspace-bound
  API-key actor with parsed scopes, and a narrow system actor with finite actions/resource kinds.
- `AuthorizationAction` and `AuthorizationResourceKind` are closed catalogs. Unknown or missing
  values deny by default.
- `AuthorizationResourceFacts` is constructed only by `AuthorizationRepository`. Facts carry the
  authoritative workspace, constrained-parent state, creator/share/project facts, a load time,
  and two-hop validity. Stale, missing, or inconsistent facts deny.
- `AuthorizationDecision` is stable and safe. It distinguishes unauthenticated (`401`), ordinary
  forbidden/recent-authentication (`403`), and concealed missing/cross-tenant (`404`) outcomes.
  Audit facts contain action/resource category and reason, but no content, credentials, URLs, or
  raw identifiers.

`AuthorizationPolicyService` is framework-neutral and is the only role/resource decision engine.
`AuthorizationEntryService` proves membership, establishes `TenantContext`, loads facts, and then
invokes the policy. `AuthorizationAdaptersService` exposes the same sequence for HTTP/REST, tRPC,
Socket join/message, files, API keys, user jobs, and system jobs.

## Permissions matrix

| Area | Owner | Admin | Editor | Viewer |
|---|---|---|---|---|
| Workspace/settings read | Yes | Yes | Yes | Yes |
| Settings update | Yes | Yes | No | No |
| Billing read/update | Yes (fresh for update) | No | No | No |
| Delete workspace | Yes, recent authentication required | No | No | No |
| List members | Yes | Yes | Yes | Yes |
| Invite/update/remove members | Yes | Yes, except modifying/removing an owner | No | No |
| Project read | All | All | Inherited projects; restricted projects only with a grant | Same |
| Project create/delete/share administration | Yes | Yes | No; delegated project editing only where explicitly granted | No |
| Note read/create | Yes | Yes | Read inherited/granted projects; create only in editable destinations | Read only where project access permits |
| Note edit | Any | Any | Creator-owned or explicit `edit` share, capped by project access | No |
| Note delete | Any | Any | No | No |
| Note sharing | Any valid grant | Any valid grant | Only while able to edit; target must be a current member; grant cannot exceed project access | No |
| Comments | Full | Full | Create where readable; edit/delete own; resolve where note-editable | Create where readable; edit/delete own |
| Export | Any readable source | Any readable source/record | Create/read/download/cancel own while source remains readable | Same requester/source rule |
| API keys/webhooks | Admin controls, recent auth for secret-bearing/destructive changes | Same | No | No |
| Audit log read/export | Yes | Yes | No | No |
| Files/attachments | Through note permission | Through note permission | Read through note; upload when note-editable; delete own upload when note-editable | Read through note only |
| Folders/tasks | Full | Full | Bounded create/update on owned/delegated content; no destructive escalation | Read only |
| Current-user sessions | Own sessions only; revoke requires freshness | Same | Same | Same |

Owner/admin project access is policy-derived and does not require `project_access` rows. Any
`project_access` row marks that project restricted. A note share cannot grant access through a
restricted project that the target cannot access.

## Tenant scoping and loading

For user requests, the only pre-context tenant query is the exact
`workspace_members(workspace_id, user_id)` membership bootstrap. The supplied workspace ID is a
selector. Only a current matching row allows `TenantContextService.run` to be entered. Every
subsequent tenant read uses `whereWorkspace`, `whereWorkspaceId`, or a constrained parent join.

Children without `workspace_id` are loaded through their authoritative parent: comments through
notes, files through both attachment and note scope, project grants through the already-scoped
project, and shares through the already-scoped note. Attachment/note workspace agreement, target
membership, project grants, and note/task tag workspace agreement are checked server-side. A
missing parent, random UUID, Alpha/Beta cross-tenant ID, or UUID-shaped probe produces the same
concealed result.

Repository work after the authorization decision must still run in the authorized context. The
HTTP interceptor uses RxJS `defer` so ALS covers controller and service execution at subscription
time. Future adapters must use `AuthorizationAdaptersService.run` (or an equivalent callback-
bounded `TenantContextService.run`) around the application service call.

## Transport and job invocation

HTTP endpoints opt in with `@RequireAuthorization(...)`. The selector callbacks only normalize
workspace/resource identifiers. `AuthorizationHttpGuard` authenticates, calls the shared entry
adapter, and stores the authorized operation; `AuthorizationHttpInterceptor` establishes the
bounded context for handler execution. The authorization module is not a global guard, so public
health and authentication routes are not accidentally protected.

Parts that own future transports must call these exact adapters:

- REST and tRPC: authenticate/validate, call `authorizeRest`/`authorizeTrpc`, then run the shared
  application service in the returned operation context.
- Socket.io: authenticate the handshake, but re-run `authorizeSocketJoin` for every room join and
  `authorizeSocketMessage` for every permission-sensitive message. Never retain ALS context on a
  connection.
- Files: call `authorizeFile`; object keys and signed URLs never replace the database lookup.
- User jobs: persist only actor/workspace/resource/action identifiers. `authorizeUserJob` creates
  no reusable browser credential and rechecks current membership/resource access.
- System jobs: use a named purpose and finite `allowedActions`/`allowedResourceKinds`. There is no
  wildcard authority. The job remains workspace-scoped.
- API keys: Part 61 authenticates the hash-only credential, parses server-stored scopes, and then
  calls `authorizeApiKey`. API-key identity is not converted into a user membership.

Parts 26–32 and later services own CRUD and transactions; they must invoke this policy rather than
copying its matrix. Part 25 may consume safe presentation flags derived from decisions, but the
backend remains authoritative.

## Authentication, freshness, rate limiting, and errors

Part 23's principal fields (`userId`, `sessionId`, assurance, expiry, authentication time, and
`isFresh`) are projected into the user actor without inventing stronger assurance. Billing
changes, workspace deletion, member privilege/removal changes, API-key secret lifecycle, webhook
configuration changes, and session revocation require freshness.

The existing Part 23 security overview and session-revocation controller now invoke the shared
session policy before the authoritative Better Auth ownership/list/revocation service. Session IDs
remain selectors; users can act only on their own server-resolved sessions.

`AuthService.authenticate` continues to install the trusted user rate-limit identity only after
Better Auth validation. Authorization consumes that principal but never changes rate-limit tiers,
and rate-limit identity never grants a role or resource permission.

Cross-tenant and guessed identifiers return safe `404`; unauthenticated requests return `401`;
known same-tenant permission failures return `403`. Transports must not replace these with raw SQL,
provider, membership, project, share, object-key, or existence detail.

## Known boundaries

- Part 24 adds no CRUD endpoints, tRPC router, gateway, worker, or object transport. Their owning
  parts wire the exported contracts.
- API-key authentication/revocation is Part 61. The Part 24 adapter accepts only an already
  authenticated, workspace-bound machine actor.
- Export creation/state machines and private object delivery are Parts 62–63. Part 24 defines the
  authorization checks they must call.
- Audit persistence/UI is Part 71. Part 24 authorization decisions are still not themselves written
  to `audit_logs`; Part 71 audits the resulting mutations, and `audit.read`/`audit.export` are the
  two actions guarding the trail.
- The repository-layer strategy from ADR 0009 remains authoritative; PostgreSQL RLS is not added.
