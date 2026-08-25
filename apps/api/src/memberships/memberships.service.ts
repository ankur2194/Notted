import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Injectable, Optional } from "@nestjs/common";
import { and, asc, desc, eq, exists, gt, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  emailDeliveries,
  invitations,
  jobOutbox,
  noteShares,
  notes,
  projectAccess,
  projects,
  type JobOutboxPayload,
  users,
  workspaces,
  workspaceMembers,
} from "../database/schema";
import {
  activeWorkspaceId,
  assertActiveWorkspace,
  createTenantContext,
  TenantContextService,
  whereWorkspace,
} from "../tenant";
import { WebhookDeliveryProducer } from "../webhooks/webhook-delivery.producer";

import { InvitationTokenService } from "./invitation-token.service";
import {
  INVITATION_EMAIL_IDEMPOTENCY_PREFIX,
  INVITATION_EMAIL_JOB_TYPE,
  INVITATION_EMAIL_PAYLOAD_VERSION,
  INVITATION_EMAIL_QUEUE_NAME,
  INVITATION_EMAIL_TEMPLATE_KEY,
  INVITATION_EXPIRY_MS,
  MEMBERSHIP_AUDIT_ACTIONS,
  ROLE_RANK,
} from "./memberships.constants";

import type {
  AuthenticatedPrincipal,
  WorkspaceInvitationAcceptResult,
  WorkspaceInvitationPage,
  WorkspaceInvitationResendResult,
  WorkspaceInvitationRevokeResult,
  WorkspaceInvitationStatus,
  WorkspaceInvitationSummary,
  WorkspaceInviteResult,
  WorkspaceMemberLeaveResult,
  WorkspaceMemberPage,
  WorkspaceMemberRemoveResult,
  WorkspaceMemberRoleChangeResult,
  WorkspaceMemberSummary,
  WorkspaceRole,
} from "@notted/shared-types";

interface WorkspaceInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface PageInput extends WorkspaceInput {
  readonly page: number;
  readonly limit: number;
}

interface InvitationRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly invitedById: string;
  readonly acceptedById: string | null;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MemberRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly joinedAt: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class MembershipsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly tokens: InvitationTokenService,
    // Part 66 — emits the `member.joined` webhook intent inside the invitation
    // acceptance transaction. Optional so the unit tests can construct this
    // service without the webhook module graph; `MembershipsModule` always
    // provides it in the running application.
    @Optional() private readonly webhookProducer?: WebhookDeliveryProducer,
  ) {}

  async listMembers(input: PageInput): Promise<WorkspaceMemberPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.list",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const rows = await this.database.db
        .select({
          id: workspaceMembers.id,
          workspaceId: workspaceMembers.workspaceId,
          userId: workspaceMembers.userId,
          name: users.name,
          email: users.email,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(whereWorkspace(workspaceMembers, this.tenantContext))
        .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toMember(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async listInvitations(
    input: PageInput & { readonly status?: WorkspaceInvitationStatus },
  ): Promise<WorkspaceInvitationPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.invite",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const now = new Date();
      const conditions: SQL[] = [whereWorkspace(invitations, this.tenantContext)];
      if (input.status === "pending") {
        conditions.push(
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        );
      } else if (input.status === "accepted") {
        conditions.push(isNotNull(invitations.acceptedAt));
      } else if (input.status === "revoked") {
        conditions.push(isNotNull(invitations.revokedAt));
      } else if (input.status === "expired") {
        conditions.push(
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          lte(invitations.expiresAt, now),
        );
      }
      const rows = await this.database.db
        .select({
          id: invitations.id,
          workspaceId: invitations.workspaceId,
          email: invitations.email,
          role: invitations.role,
          invitedById: invitations.invitedById,
          acceptedById: invitations.acceptedById,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          createdAt: invitations.createdAt,
          updatedAt: invitations.updatedAt,
        })
        .from(invitations)
        .where(and(...conditions))
        .orderBy(desc(invitations.createdAt), asc(invitations.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toInvitation(row, now))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async invite(
    input: WorkspaceInput & { readonly email: string; readonly role: WorkspaceRole },
  ): Promise<WorkspaceInviteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.invite",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const email = normalizeEmail(input.email);
      return this.database.transaction(async (tx) => {
        await this.lockMutation(tx, `invitation:${input.workspaceId}:${email}`);
        const actorRole = await this.actorRole(tx, input.principal.userId);
        this.assertCanGrantRole(actorRole, input.role);
        await this.assertNotExistingMember(tx, email);
        await this.assertNoPendingInvitation(tx, email);

        const invitation = await this.createInvitation(tx, {
          workspaceId: input.workspaceId,
          email,
          role: input.role,
          actorId: input.principal.userId,
          requestId: input.requestId,
        });
        await this.writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.principal.userId,
          action: MEMBERSHIP_AUDIT_ACTIONS.invite,
          entityType: "invitation",
          entityId: invitation.id,
          metadata: { invitationId: invitation.id, status: "pending", role: invitation.role },
          requestId: input.requestId,
        });
        return Object.freeze({ invitation: Object.freeze(this.toInvitation(invitation)) });
      });
    });
  }

  async accept(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly token: string;
    readonly requestId?: string | null;
  }): Promise<WorkspaceInvitationAcceptResult> {
    const tokenHash = this.tokens.hash(input.token);
    // Credential bootstrap cannot require membership. Resolve only opaque IDs
    // from the globally unique token hash and prove the workspace still exists;
    // every invitation/member mutation happens later inside that tenant scope.
    const [resolved] = await this.database.db
      .select({ id: invitations.id, workspaceId: invitations.workspaceId })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    if (resolved === undefined) this.invitationUnavailable();

    return this.tenantContext.run(
      createTenantContext({
        workspaceId: resolved.workspaceId,
        userId: input.principal.userId,
        requestId: input.requestId ?? null,
      }),
      async () =>
        this.database.transaction(async (tx) => {
          await this.lockInvitation(tx, resolved.id);
          const invitation = await this.pendingInvitation(tx, resolved.id, {
            requireUnexpired: true,
            tokenHash,
          });
          const [user] = await tx
            .select({ id: users.id, email: users.email, name: users.name })
            .from(users)
            .where(eq(users.id, input.principal.userId))
            .limit(1);
          if (
            user === undefined ||
            normalizeEmail(user.email) !== normalizeEmail(invitation.email)
          ) {
            this.invitationUnavailable();
          }
          const now = new Date();
          const [existing] = await tx
            .select({
              id: workspaceMembers.id,
              workspaceId: workspaceMembers.workspaceId,
              userId: workspaceMembers.userId,
              role: workspaceMembers.role,
              joinedAt: workspaceMembers.joinedAt,
            })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.userId, user.id),
                whereWorkspace(workspaceMembers, this.tenantContext),
              ),
            )
            .limit(1);

          let membership = existing;
          let joined = false;
          if (membership === undefined) {
            const id = randomUUID();
            const [inserted] = await tx
              .insert(workspaceMembers)
              .values({
                id,
                workspaceId: invitation.workspaceId,
                userId: user.id,
                role: invitation.role,
                joinedAt: now,
              })
              .onConflictDoNothing()
              .returning({
                id: workspaceMembers.id,
                workspaceId: workspaceMembers.workspaceId,
                userId: workspaceMembers.userId,
                role: workspaceMembers.role,
                joinedAt: workspaceMembers.joinedAt,
              });
            membership = inserted;
            joined = inserted !== undefined;
            if (membership === undefined) {
              [membership] = await tx
                .select({
                  id: workspaceMembers.id,
                  workspaceId: workspaceMembers.workspaceId,
                  userId: workspaceMembers.userId,
                  role: workspaceMembers.role,
                  joinedAt: workspaceMembers.joinedAt,
                })
                .from(workspaceMembers)
                .where(
                  and(
                    eq(workspaceMembers.userId, user.id),
                    whereWorkspace(workspaceMembers, this.tenantContext),
                  ),
                )
                .limit(1);
            }
          }
          if (membership === undefined)
            throw this.conflict("The invitation could not be accepted.");

          const updated = await tx
            .update(invitations)
            .set({ acceptedAt: now, acceptedById: user.id, updatedAt: now })
            .where(
              and(
                eq(invitations.id, invitation.id),
                eq(invitations.tokenHash, tokenHash),
                whereWorkspace(invitations, this.tenantContext),
                isNull(invitations.acceptedAt),
                isNull(invitations.revokedAt),
                gt(invitations.expiresAt, now),
              ),
            )
            .returning({ id: invitations.id });
          if (updated.length !== 1) this.invitationUnavailable();
          await this.writeAudit(tx, {
            workspaceId: invitation.workspaceId,
            actorId: user.id,
            action: MEMBERSHIP_AUDIT_ACTIONS.accept,
            entityType: "invitation",
            entityId: invitation.id,
            metadata: { invitationId: invitation.id, status: "accepted", role: membership.role },
            requestId: input.requestId,
          });
          // Part 66. ONLY on a real join: re-accepting an invitation for an
          // existing member (`joined === false`) is not a `member.joined` event,
          // and announcing it would make a receiver's "welcome the new member"
          // automation fire twice. Committed in the SAME transaction as the
          // audit row, so a rollback takes the announcement with it.
          //
          // There is deliberately no `DOMAIN_JOB_TYPES` entry, no membership
          // event constant and no membership outbox plumbing behind this: the
          // event name is just a string in `webhooks.events` and in the
          // `webhook.deliver` payload.
          if (joined) {
            await this.webhookProducer?.scheduleWebhookDeliveries(tx, {
              event: "member.joined",
              workspaceId: invitation.workspaceId,
              resourceId: membership.id,
              actorId: user.id,
              occurredAt: now,
              correlationId: input.requestId ?? null,
            });
          }
          return Object.freeze({
            membership: Object.freeze(
              this.toMember({ ...membership, name: user.name, email: normalizeEmail(user.email) }),
            ),
            joined,
          });
        }),
    );
  }

  async resend(
    input: WorkspaceInput & { readonly invitationId: string },
  ): Promise<WorkspaceInvitationResendResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.invite",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        await this.lockInvitation(tx, input.invitationId);
        const old = await this.pendingInvitation(tx, input.invitationId);
        await this.lockMutation(tx, `invitation:${input.workspaceId}:${normalizeEmail(old.email)}`);
        const actorRole = await this.actorRole(tx, input.principal.userId);
        this.assertCanGrantRole(actorRole, old.role);
        await this.assertNotExistingMember(tx, normalizeEmail(old.email));
        const now = new Date();
        const revoked = await tx
          .update(invitations)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(invitations.id, old.id),
              whereWorkspace(invitations, this.tenantContext),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (revoked.length !== 1) throw this.conflict("The invitation is no longer pending.");
        await this.assertNoPendingInvitation(tx, normalizeEmail(old.email));
        const replacement = await this.createInvitation(tx, {
          workspaceId: old.workspaceId,
          email: normalizeEmail(old.email),
          role: old.role,
          actorId: input.principal.userId,
          requestId: input.requestId,
        });
        await this.writeAudit(tx, {
          workspaceId: old.workspaceId,
          actorId: input.principal.userId,
          action: MEMBERSHIP_AUDIT_ACTIONS.resend,
          entityType: "invitation",
          entityId: replacement.id,
          metadata: {
            invitationId: replacement.id,
            replacedInvitationId: old.id,
            status: "pending",
            role: old.role,
          },
          requestId: input.requestId,
        });
        return Object.freeze({
          revokedInvitationId: old.id,
          invitation: Object.freeze(this.toInvitation(replacement)),
        });
      }),
    );
  }

  async revoke(
    input: WorkspaceInput & { readonly invitationId: string },
  ): Promise<WorkspaceInvitationRevokeResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.invite",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        await this.lockInvitation(tx, input.invitationId);
        const invitation = await this.pendingInvitation(tx, input.invitationId);
        const now = new Date();
        const revoked = await tx
          .update(invitations)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(invitations.id, invitation.id),
              whereWorkspace(invitations, this.tenantContext),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (revoked.length !== 1) throw this.conflict("The invitation is no longer pending.");
        await this.writeAudit(tx, {
          workspaceId: invitation.workspaceId,
          actorId: input.principal.userId,
          action: MEMBERSHIP_AUDIT_ACTIONS.revoke,
          entityType: "invitation",
          entityId: invitation.id,
          metadata: { invitationId: invitation.id, status: "revoked" },
          requestId: input.requestId,
        });
        return Object.freeze({ invitationId: invitation.id, revoked: true as const });
      }),
    );
  }

  async changeRole(
    input: WorkspaceInput & { readonly memberId: string; readonly role: WorkspaceRole },
  ): Promise<WorkspaceMemberRoleChangeResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.update",
      resource: { kind: "member", id: input.memberId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        await this.lockMutation(tx, `owners:${input.workspaceId}`);
        const actor = await this.actorMembership(tx, input.principal.userId);
        const target = await this.memberById(tx, input.memberId);
        this.assertCanManageMember(actor, target, input.role);
        if (target.userId === actor.userId && ROLE_RANK[input.role] > ROLE_RANK[target.role]) {
          throw this.forbidden("You cannot elevate your own workspace role.");
        }
        if (target.role === input.role) throw this.conflict("The member already has that role.");
        if (target.role === "owner" && input.role !== "owner") await this.assertOwnerRemains(tx);
        await tx
          .update(workspaceMembers)
          .set({ role: input.role })
          .where(
            and(
              eq(workspaceMembers.id, target.id),
              whereWorkspace(workspaceMembers, this.tenantContext),
            ),
          );
        await this.writeAudit(tx, {
          workspaceId: target.workspaceId,
          actorId: actor.userId,
          action: MEMBERSHIP_AUDIT_ACTIONS.roleChange,
          entityType: "member",
          entityId: target.id,
          metadata: { from: target.role, to: input.role },
          requestId: input.requestId,
        });
        return Object.freeze({
          membership: Object.freeze(this.toMember({ ...target, role: input.role })),
          previousRole: target.role,
        });
      }),
    );
  }

  async remove(
    input: WorkspaceInput & { readonly memberId: string },
  ): Promise<WorkspaceMemberRemoveResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.remove",
      resource: { kind: "member", id: input.memberId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        await this.lockMutation(tx, `owners:${input.workspaceId}`);
        const actor = await this.actorMembership(tx, input.principal.userId);
        const target = await this.memberById(tx, input.memberId);
        if (target.userId === actor.userId)
          throw this.conflict("Use the leave operation to remove your own membership.");
        this.assertCanManageMember(actor, target);
        if (target.role === "owner") await this.assertOwnerRemains(tx);
        await this.clearWorkspaceGrants(tx, target.userId);
        await tx
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.id, target.id),
              whereWorkspace(workspaceMembers, this.tenantContext),
            ),
          );
        await this.writeAudit(tx, {
          workspaceId: target.workspaceId,
          actorId: actor.userId,
          action: MEMBERSHIP_AUDIT_ACTIONS.remove,
          entityType: "member",
          entityId: target.id,
          metadata: { role: target.role },
          requestId: input.requestId,
        });
        return Object.freeze({ memberId: target.id, removed: true as const });
      }),
    );
  }

  async leave(input: WorkspaceInput): Promise<WorkspaceMemberLeaveResult> {
    if (!input.principal.isFresh) {
      throw new ApiHttpException(HttpStatus.FORBIDDEN, {
        code: "RECENT_AUTHENTICATION_REQUIRED",
        message: "Confirm your identity to continue.",
      });
    }
    // Self-leave is available to every role. `member.list` proves a current
    // membership without incorrectly applying admin-only member.remove policy.
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "member.list",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        await this.lockMutation(tx, `owners:${input.workspaceId}`);
        const member = await this.actorMembership(tx, input.principal.userId);
        if (member.role === "owner") await this.assertOwnerRemains(tx);
        await this.clearWorkspaceGrants(tx, member.userId);
        await tx
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.id, member.id),
              whereWorkspace(workspaceMembers, this.tenantContext),
            ),
          );
        await this.writeAudit(tx, {
          workspaceId: member.workspaceId,
          actorId: member.userId,
          action: MEMBERSHIP_AUDIT_ACTIONS.leave,
          entityType: "member",
          entityId: member.id,
          metadata: { role: member.role },
          requestId: input.requestId,
        });
        return Object.freeze({ memberId: member.id, left: true as const });
      }),
    );
  }

  /** Removes only grants whose constrained parent belongs to the active workspace. */
  private async clearWorkspaceGrants(tx: DatabaseTransaction, userId: string): Promise<void> {
    await tx.delete(noteShares).where(
      and(
        eq(noteShares.userId, userId),
        exists(
          tx
            .select({ id: notes.id })
            .from(notes)
            .where(and(eq(notes.id, noteShares.noteId), whereWorkspace(notes, this.tenantContext))),
        ),
      ),
    );
    await tx.delete(projectAccess).where(
      and(
        eq(projectAccess.userId, userId),
        exists(
          tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, projectAccess.projectId),
                whereWorkspace(projects, this.tenantContext),
              ),
            ),
        ),
      ),
    );
  }

  private async createInvitation(
    tx: DatabaseTransaction,
    input: {
      readonly workspaceId: string;
      readonly email: string;
      readonly role: WorkspaceRole;
      readonly actorId: string;
      readonly requestId?: string | null;
    },
  ): Promise<InvitationRow> {
    const now = new Date();
    const invitationId = randomUUID();
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "invitation insert");
    const workspaceId = activeWorkspaceId(this.tenantContext);
    const row: InvitationRow = {
      id: invitationId,
      workspaceId,
      email: input.email,
      role: input.role,
      invitedById: input.actorId,
      acceptedById: null,
      expiresAt: new Date(now.getTime() + INVITATION_EXPIRY_MS),
      acceptedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx
      .insert(invitations)
      .values({ ...row, tokenHash: this.tokens.hashForInvitation(invitationId) });
    await this.queueInvitationEmail(tx, row, input.requestId);
    return row;
  }

  private async queueInvitationEmail(
    tx: DatabaseTransaction,
    invitation: InvitationRow,
    requestId?: string | null,
  ): Promise<void> {
    assertActiveWorkspace(invitation.workspaceId, this.tenantContext, "invitation email insert");
    const deliveryId = randomUUID();
    await tx.insert(emailDeliveries).values({
      id: deliveryId,
      workspaceId: invitation.workspaceId,
      recipient: invitation.email,
      templateKey: INVITATION_EMAIL_TEMPLATE_KEY,
      relatedEntityType: "invitation",
      relatedEntityId: invitation.id,
    });
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: INVITATION_EMAIL_JOB_TYPE,
      intentId: outboxId,
      workspaceId: invitation.workspaceId,
      resourceIds: Object.freeze([invitation.id, deliveryId]),
      actorId: invitation.invitedById,
    });
    await tx.insert(jobOutbox).values({
      id: outboxId,
      workspaceId: invitation.workspaceId,
      queueName: INVITATION_EMAIL_QUEUE_NAME,
      jobType: INVITATION_EMAIL_JOB_TYPE,
      payloadVersion: INVITATION_EMAIL_PAYLOAD_VERSION,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${INVITATION_EMAIL_IDEMPOTENCY_PREFIX}${invitation.id}`,
      correlationId: requestId ?? null,
    });
  }

  private async actorRole(tx: DatabaseTransaction, userId: string): Promise<WorkspaceRole> {
    return (await this.actorMembership(tx, userId)).role;
  }

  private async actorMembership(tx: DatabaseTransaction, userId: string): Promise<MemberRow> {
    const [row] = await tx
      .select({
        id: workspaceMembers.id,
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1)
      .for("update", { of: workspaceMembers });
    if (row === undefined) this.notFound();
    return row;
  }

  private async memberById(tx: DatabaseTransaction, memberId: string): Promise<MemberRow> {
    const [row] = await tx
      .select({
        id: workspaceMembers.id,
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1)
      .for("update", { of: workspaceMembers });
    if (row === undefined) this.notFound();
    return row;
  }

  private async pendingInvitation(
    tx: DatabaseTransaction,
    invitationId: string,
    options: { readonly requireUnexpired?: boolean; readonly tokenHash?: string } = {},
  ): Promise<InvitationRow> {
    const now = new Date();
    const conditions: SQL[] = [
      eq(invitations.id, invitationId),
      whereWorkspace(invitations, this.tenantContext),
    ];
    if (options.tokenHash !== undefined)
      conditions.push(eq(invitations.tokenHash, options.tokenHash));
    const [row] = await tx
      .select({
        id: invitations.id,
        workspaceId: invitations.workspaceId,
        email: invitations.email,
        role: invitations.role,
        invitedById: invitations.invitedById,
        acceptedById: invitations.acceptedById,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        createdAt: invitations.createdAt,
        updatedAt: invitations.updatedAt,
      })
      .from(invitations)
      .where(and(...conditions))
      .limit(1);
    if (row === undefined) this.notFound();
    if (
      row.acceptedAt !== null ||
      row.revokedAt !== null ||
      (options.requireUnexpired === true && row.expiresAt.getTime() <= now.getTime())
    ) {
      throw this.conflict("The invitation is no longer pending.");
    }
    return row;
  }

  private async assertNotExistingMember(tx: DatabaseTransaction, email: string): Promise<void> {
    const [row] = await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          sql`lower(${users.email}) = ${email}`,
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1);
    if (row !== undefined) throw this.conflict("That user is already a workspace member.");
  }

  private async assertNoPendingInvitation(tx: DatabaseTransaction, email: string): Promise<void> {
    const [row] = await tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          sql`lower(${invitations.email}) = ${email}`,
          whereWorkspace(invitations, this.tenantContext),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (row !== undefined)
      throw this.conflict("A pending invitation already exists for that address.");
  }

  private assertCanGrantRole(actorRole: WorkspaceRole, requestedRole: WorkspaceRole): void {
    if (actorRole !== "owner" && actorRole !== "admin")
      throw this.forbidden("You cannot manage invitations.");
    if (requestedRole === "owner" && actorRole !== "owner") {
      throw this.forbidden("Only an owner can grant the owner role.");
    }
  }

  private assertCanManageMember(
    actor: MemberRow,
    target: MemberRow,
    requestedRole?: WorkspaceRole,
  ): void {
    if (actor.role !== "owner" && actor.role !== "admin")
      throw this.forbidden("You cannot manage members.");
    if (actor.role === "admin" && (target.role === "owner" || requestedRole === "owner")) {
      throw this.forbidden("An admin cannot manage or create an owner membership.");
    }
  }

  private async assertOwnerRemains(tx: DatabaseTransaction): Promise<void> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.role, "owner"),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      );
    if ((row?.count ?? 0) <= 1)
      throw this.conflict("The workspace must retain at least one owner.");
  }

  private async lockMutation(tx: DatabaseTransaction, key: string): Promise<void> {
    // All owner-changing operations use the same workspace key. PostgreSQL's
    // transaction advisory lock serializes the count + mutation without a
    // schema change and releases automatically on commit/rollback.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  private lockInvitation(tx: DatabaseTransaction, invitationId: string): Promise<void> {
    return this.lockMutation(tx, `invitation-id:${invitationId}`);
  }

  private async writeAudit(
    tx: DatabaseTransaction,
    input: {
      readonly workspaceId: string;
      readonly actorId: string;
      readonly action: string;
      readonly entityType: string;
      readonly entityId: string;
      readonly metadata: Record<string, unknown>;
      readonly requestId?: string | null;
    },
  ): Promise<void> {
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "audit insert");
    await recordAudit(tx, {
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata,
      requestId: input.requestId ?? null,
    });
  }

  private toMember(row: MemberRow): WorkspaceMemberSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      name: row.name,
      email: normalizeEmail(row.email),
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    };
  }

  private toInvitation(row: InvitationRow, now = new Date()): WorkspaceInvitationSummary {
    let status: WorkspaceInvitationStatus = "pending";
    if (row.acceptedAt !== null) status = "accepted";
    else if (row.revokedAt !== null) status = "revoked";
    else if (row.expiresAt.getTime() <= now.getTime()) status = "expired";
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      email: normalizeEmail(row.email),
      role: row.role,
      status,
      invitedById: row.invitedById,
      acceptedById: row.acceptedById,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private conflict(message: string): ApiHttpException {
    return new ApiHttpException(HttpStatus.CONFLICT, { code: "CONFLICT", message });
  }

  private forbidden(message: string): ApiHttpException {
    return new ApiHttpException(HttpStatus.FORBIDDEN, { code: "FORBIDDEN", message });
  }

  private invitationUnavailable(): never {
    throw this.conflict("The invitation is invalid, expired, revoked, or already used.");
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
