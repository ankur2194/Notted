# ADR 0011: Explicit durable project restriction state

- **Status:** Accepted
- **Date:** 2026-08-01
- **Related plan parts:** 15, 24, 29–32
- **Supersedes:** ADR 0007's grant-count representation of project restriction

## Context

ADR 0007 correctly requires restricted projects to deny access by default, but its original representation treated the presence of any `project_access` row as the restriction flag. Removing or cleaning up the final grant therefore changed a restricted project into a workspace-visible project. Membership removal, leave, and concurrent grant cleanup could unintentionally widen access.

## Decision

`projects.is_restricted` is the authoritative durable restriction state. It is non-null and defaults to `false`, so new projects inherit workspace visibility unless a future authorized project-access administration flow deliberately restricts them.

`project_access` rows are grants only. Their creation, update, deletion, membership cleanup, or absence never changes `is_restricted`. For a restricted project, workspace owners and admins retain administrative access and every other actor needs a current explicit grant. For an inherited project, active workspace membership remains sufficient regardless of incidental grant rows.

Project and note authorization facts, list predicates, navigation predicates, and member projections must consult `is_restricted`; grant counts must never infer visibility.

## Alternatives considered

- Preserve a sentinel grant: rejected because user lifecycle rows are not durable project policy and a sentinel is hard to authorize and audit.
- Derive restriction from historical audit events: rejected because authorization must use a direct transactional fact.
- Prevent deletion of the final grant: rejected because membership removal must remain possible and a zero-grantee restricted project is a valid deny-by-default state.

## Consequences

Restricted projects can safely have zero grantees. Removing and rejoining a member does not restore access. A later project-access administration feature must explicitly toggle the project field and manage grants without coupling those operations accidentally.

## Migration and rollback

Forward migration `0013_free_lockheed.sql` adds the column with a constant default and backfills `true` for every existing project with at least one grant. The additive column is compatible with the preceding application while rollout is coordinated, but the backfill updates matching project rows and may contend with concurrent project writes; schedule large installations in a low-traffic window. The migration also adds the note deletion-batch column and template/archive ordering indexes.

Rollback must be a reviewed forward correction. Dropping the column would reintroduce the access-widening defect, so application rollback should retain the column and deploy code that continues to honor it.
