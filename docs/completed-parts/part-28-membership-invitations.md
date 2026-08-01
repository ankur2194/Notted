# Part 28 — Implement membership and invitation flows

## Status

- **State:** Complete
- **Completed on:** 2026-08-01
- **Implemented by:** Phase 5 Parts 26–29 coordinated delivery session
- **Plan reference:** `Plan.md`, Part 28
- **Related records:** Parts 14, 18, 21, 24, 26, 27

## Objective

Provide invite, accept, list, role-change, resend, revoke, leave, and remove-member operations with single-use expiring credentials, role safety, last-owner protection, durable branded email delivery, and audit evidence.

## Implemented Work

- Added shared membership/invitation contracts and thin REST endpoints.
- Added transactional service operations for member/invitation lists, invite, accept, role change, resend, revoke, leave, and removal.
- Normalizes emails, prevents duplicate pending invitations and existing-member invites, and supports both existing and newly registered recipients.
- Uses seven-day, domain-separated HMAC-derived invitation tokens; only token hashes persist.
- Enforces single use, expiry/revocation, recipient-email matching, role boundaries, self-elevation prevention, and last-owner protection under advisory locks.
- Writes identifier-only audit and durable email outbox records in the mutation transaction.
- Added a reclaiming dispatcher, BullMQ queue/worker, SMTP template, delivery/idempotency state transitions, stale-invitation cancellation, and readiness reporting.
- Added the authenticated `/invitations/accept` frontend flow.

## Important Decisions

- The token is deterministically derived from the invitation UUID and an application secret only when an email must be sent; plaintext is never stored in PostgreSQL, queues, or logs.
- Resend revokes the old invitation and creates a new credential rather than reactivating a previously exposed token.
- Invitation email delivery reuses the existing transactional-email infrastructure/configuration and keeps the outbox payload to invitation/delivery identifiers.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/memberships/` | Service, REST controller, token logic, dispatcher, queue, worker, module, and tests |
| `packages/shared-validators/src/workspace.schema.ts` | Membership and invitation validation contracts |
| `packages/shared-types/src/workspace.ts` | Membership/invitation response types and API paths |
| `apps/web/src/app/invitations/accept/page.tsx` | Invitation acceptance route |
| `apps/web/src/components/workspaces/AcceptWorkspaceInvitation.tsx` | Acceptance interaction and safe states |

## Database and Data Changes

No new Part 28 migration. The implementation uses existing `invitations`, `workspace_members`, `email_deliveries`, `job_outbox`, `job_idempotency`, and `audit_logs` tables.

## API, Configuration, and Operational Changes

- `GET /api/v1/workspaces/:workspaceId/members`
- `GET/POST /api/v1/workspaces/:workspaceId/invitations`
- `POST /api/v1/workspaces/:workspaceId/invitations/:invitationId/resend`
- `DELETE /api/v1/workspaces/:workspaceId/invitations/:invitationId`
- `POST /api/v1/invitations/accept`
- `PATCH/DELETE /api/v1/workspaces/:workspaceId/members/:memberId`
- `POST /api/v1/workspaces/:workspaceId/members/leave`
- Email outbox jobs use `workspace.invitation.send` on `transactional-email`; existing Redis, SMTP, email feature, retry, and retention configuration is reused.

## Security and Tenant-Isolation Notes

- Administrative endpoints use centralized member actions and tenant context; acceptance is authentication-only until the opaque token establishes the target workspace.
- Mutations require trusted origins. Cross-tenant IDs and invalid/expired/reused tokens return safe responses.
- Owner/admin rank checks prevent privilege escalation, and row/advisory locking protects concurrent last-owner and invitation transitions.
- Tokens, message bodies, recipient addresses, and action URLs are excluded from worker logs and queue payloads.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| Focused membership/controller/worker suites | Pass | Included in the 49 passing focused Parts 26/28/29 API tests |
| Disposable PostgreSQL integration | Pass | Included in 12 live tests covering token state, roles, last-owner rules, and tenant boundaries |
| `DATABASE_URL=<disposable> pnpm test` | Pass | Repository suites passed; API reported 562 passed with 3 unrelated infrastructure-dependent skips |
| `pnpm format:check` / `pnpm lint` / `pnpm type-check` | Pass | Repository-wide static gates passed |
| `pnpm build` | Pass | Worker and API production compilation passed |
| Chromium invitation journey | Pass | Real Mailpit delivery, registration, single-use acceptance, and viewer settings denial passed |

## Known Limitations and Follow-up Work

- Rich membership-management screens are not part of Part 28; operations are available through the verified APIs.
- Central audit enrichment remains owned by Part 71.

## Handoff Notes

- Keep email enqueueing post-commit through `job_outbox`; do not place raw tokens or email content in durable intents.
- Changes to token derivation require compatibility planning for pending invitations.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Coordinated delivery session | Implemented and verified membership, invitation, and email-delivery flows |
