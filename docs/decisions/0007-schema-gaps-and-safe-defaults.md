# ADR 0007: Schema gaps and deny-by-default product defaults

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 13–19, 21–24, 28, 40–45, 47–49, 61–69

## Context

The illustrative schema in `Notted.md` omits entities required by its feature specification. Implementing against it literally would force unsafe implicit behavior or late incompatible migrations.

## Decision

Later schema parts must add the following workspace-scoped models. These defaults resolve behavior only; the responsible schema part still owns final names, constraints, indexes, and reviewed migrations.

| Gap | Safe default and ownership |
|---|---|
| Standalone tasks | Add first-class workspace-owned tasks, optionally linked to a project/note/checklist source. Assignee and due date are optional; status starts `todo`; source links do not grant access. Only authorized workspace members can read them. |
| Project membership/access | **Representation superseded by ADR 0011.** Projects default to inheriting workspace access. Restricted projects deny users without an explicit project grant; workspace owner/admin retain administrative access. Never infer access from authorship alone. `projects.is_restricted`, not grant count, is authoritative. |
| Note ordering | Store explicit stable sibling ordering scoped by workspace plus parent/project context. New notes append; reorder operations are transactional and reject cross-container or cross-workspace identifiers. |
| Folders | Model folders as workspace-owned containers, separate from notes. A note has at most one folder; folders may nest to a maximum depth of three levels, with both the depth limit and cycle prevention enforced in service logic. Folders inherit workspace/project access and cannot broaden child access. Root/unfiled is the default. |
| Note sharing | Add explicit grants for workspace users/groups with `view`, `comment`, or `edit`; no public link by default. A grant cannot exceed the actor's delegation rights or bypass project restrictions. Public sharing, if later authorized, uses revocable hashed tokens, expiry, and least privilege. |
| Invitations | Add workspace-scoped, single-use invitations with normalized target email, intended role, hashed token, expiry, inviter, and accepted/revoked timestamps. Default role is viewer; expiry is seven days; acceptance requires the authenticated email to match. Project grants are optional and never broaden workspace role. |
| Sessions | Let Better Auth own credential/session lifecycle tables, with Notted metadata only where required. Sessions are server-revocable, hashed or provider-protected at rest, tied to a user, expire, and default to one day unless remember-me explicitly selects 30 days. Redis may cache but PostgreSQL/provider storage is authoritative. |
| Webhooks/deliveries | Add workspace-owned webhook endpoints and immutable delivery attempts. Endpoints start disabled until verified; secrets are encrypted and shown once; HTTPS is required outside development. Deliveries are signed, idempotent, bounded, retried with backoff, and never include data outside the endpoint's scopes. |
| AI configuration/usage | Add workspace AI settings and append-only usage records. AI is disabled by default. Provider secrets are encrypted and never returned or logged. Only authorized admins configure providers; quotas fail closed; requests and output content are not retained in usage rows by default. |
| Email delivery status | Add an email intent/delivery record with template key, safe recipient reference, status, attempts, provider message ID, and timestamps. Queueing is transactional/outbox-backed and idempotent; logs and records omit rendered bodies, tokens, and magic links. |
| Export records | Add workspace/user-owned export jobs with format, source scope, status, signed-link expiry, object-retention expiry, object key, and error code. Authorization is rechecked at creation and download. Objects remain private; download grants expire after seven days as required by `Notted.md`. Object retention is a separate lifecycle policy: retain completed export objects for seven days by default, then delete them asynchronously; failed/cancelled jobs cannot be downloaded and their partial objects are cleaned up promptly. |

All tenant-owned rows carry `workspace_id` directly when practical or have an unambiguous constrained path to it. Service policies and later database protections prove that boundary. Cross-workspace foreign-key combinations must be impossible or transactionally rejected; a bare UUID never grants access.

## Alternatives considered

- Add columns ad hoc while implementing features: rejected because ownership and authorization would vary by feature.
- Store these concerns in generic JSON: rejected for security-critical relations, lifecycle queries, constraints, and auditability.
- Make all projects and notes workspace-visible permanently: rejected because the brief requires explicit sharing and editor restrictions.

## Consequences

Parts 13–19 must reconcile provider-generated auth schema with these contracts and document any renamed tables. Feature parts must preserve deny-by-default behavior. This ADR deliberately does not pre-implement later schema parts.

## Migration and rollback

No database exists yet. Later migrations must include backfill, locking, rollback, retention, and tenant-isolation analysis in their completion records.
