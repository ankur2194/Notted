import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService } from "../src/database/database.service";
import {
  auditLogs,
  emailDeliveries,
  invitations,
  jobOutbox,
  schema,
  users,
  workspaces,
  workspaceMembers,
} from "../src/database/schema";
import { InvitationTokenService } from "../src/memberships/invitation-token.service";
import { INVITATION_EMAIL_JOB_TYPE } from "../src/memberships/memberships.constants";
import { MembershipsService } from "../src/memberships/memberships.service";
import { TenantContextService } from "../src/tenant";

import type { AuthConfig } from "../src/config/auth.config";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;
const TOKEN_SECRET = "part-28-integration-secret-that-is-long-enough";

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `session:${userId}`,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

async function reachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe.skipIf(!HAS_DATABASE_URL)("Part 28 memberships and invitations (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let databaseReachable = false;

  beforeAll(async () => {
    databaseReachable = await reachable(DATABASE_URL as string);
    if (!databaseReachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  function service(): { memberships: MembershipsService; tokens: InvitationTokenService } {
    if (pool === undefined || db === undefined) throw new Error("database unavailable");
    const tenant = new TenantContextService();
    const database = new DatabaseService(pool, db);
    const repository = new AuthorizationRepository(database, tenant);
    const entry = new AuthorizationEntryService(
      repository,
      new AuthorizationPolicyService(),
      tenant,
    );
    const tokens = new InvitationTokenService({ secret: TOKEN_SECRET } as AuthConfig);
    return { memberships: new MembershipsService(database, entry, tenant, tokens), tokens };
  }

  it("covers unregistered/existing users, single use, role boundaries, isolation, resend, and atomic intents", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const ownerId = randomUUID();
    const adminId = randomUUID();
    const editorId = randomUUID();
    const existingInviteeId = randomUUID();
    const unregisteredInviteeId = randomUUID();
    const expiredInviteeId = randomUUID();
    const revokedInviteeId = randomUUID();
    const racedInviteeId = randomUUID();
    const terminalRaceInviteeId = randomUUID();
    const resendRaceInviteeId = randomUUID();
    const betaOwnerId = randomUUID();
    const alphaWorkspaceId = randomUUID();
    const betaWorkspaceId = randomUUID();
    const fixtureWorkspaceIds = [alphaWorkspaceId, betaWorkspaceId];
    const fixtureUserIds = [
      ownerId,
      adminId,
      editorId,
      existingInviteeId,
      unregisteredInviteeId,
      expiredInviteeId,
      revokedInviteeId,
      racedInviteeId,
      terminalRaceInviteeId,
      resendRaceInviteeId,
      betaOwnerId,
    ];
    const suffix = randomUUID().slice(0, 8);
    const existingEmail = `existing-${suffix}@example.test`;
    const unregisteredEmail = `unregistered-${suffix}@example.test`;
    const expiredEmail = `expired-${suffix}@example.test`;
    const revokedEmail = `revoked-${suffix}@example.test`;
    const racedEmail = `raced-${suffix}@example.test`;
    const terminalRaceEmail = `terminal-race-${suffix}@example.test`;
    const resendRaceEmail = `resend-race-${suffix}@example.test`;

    try {
      await db.insert(users).values([
        { id: ownerId, email: `owner-${suffix}@example.test`, name: "Owner" },
        { id: adminId, email: `admin-${suffix}@example.test`, name: "Admin" },
        { id: editorId, email: `editor-${suffix}@example.test`, name: "Editor" },
        { id: existingInviteeId, email: existingEmail, name: "Existing invitee" },
        { id: expiredInviteeId, email: expiredEmail, name: "Expired invitee" },
        { id: revokedInviteeId, email: revokedEmail, name: "Revoked invitee" },
        { id: racedInviteeId, email: racedEmail, name: "Raced invitee" },
        { id: terminalRaceInviteeId, email: terminalRaceEmail, name: "Terminal race invitee" },
        { id: resendRaceInviteeId, email: resendRaceEmail, name: "Resend race invitee" },
        { id: betaOwnerId, email: `beta-${suffix}@example.test`, name: "Beta owner" },
      ]);
      await db.insert(workspaces).values([
        {
          id: alphaWorkspaceId,
          name: "Part 28 Alpha",
          slug: `part-28-alpha-${suffix}`,
          createdById: ownerId,
        },
        {
          id: betaWorkspaceId,
          name: "Part 28 Beta",
          slug: `part-28-beta-${suffix}`,
          createdById: betaOwnerId,
        },
      ]);
      const ownerMemberId = randomUUID();
      const adminMemberId = randomUUID();
      const betaOwnerMemberId = randomUUID();
      await db.insert(workspaceMembers).values([
        { id: ownerMemberId, workspaceId: alphaWorkspaceId, userId: ownerId, role: "owner" },
        { id: adminMemberId, workspaceId: alphaWorkspaceId, userId: adminId, role: "admin" },
        { id: randomUUID(), workspaceId: alphaWorkspaceId, userId: editorId, role: "editor" },
        { id: betaOwnerMemberId, workspaceId: betaWorkspaceId, userId: betaOwnerId, role: "owner" },
      ]);

      const { memberships, tokens } = service();
      const owner = principal(ownerId);
      const admin = principal(adminId);
      const editor = principal(editorId);

      // Existing registered users and addresses with no user row are both valid.
      const existingInvite = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: `  ${existingEmail.toUpperCase()}  `,
        role: "editor",
      });
      const unregisteredInvite = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: unregisteredEmail.toUpperCase(),
        role: "viewer",
      });
      expect(existingInvite.invitation.email).toBe(existingEmail);
      expect(unregisteredInvite.invitation.email).toBe(unregisteredEmail);
      expect(existingInvite.invitation).not.toHaveProperty("tokenHash");

      await expect(
        memberships.invite({
          principal: owner,
          workspaceId: alphaWorkspaceId,
          email: existingEmail,
          role: "viewer",
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "CONFLICT" } });
      await expect(
        memberships.invite({
          principal: owner,
          workspaceId: alphaWorkspaceId,
          email: `owner-${suffix}@example.test`,
          role: "viewer",
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "CONFLICT" } });

      // Wrong authenticated mailbox cannot redeem the otherwise valid token.
      const existingToken = tokens.derive(existingInvite.invitation.id);
      await expect(
        memberships.accept({ principal: admin, token: existingToken }),
      ).rejects.toMatchObject({
        safeResponse: { code: "CONFLICT" },
      });
      const existingAccepted = await memberships.accept({
        principal: principal(existingInviteeId),
        token: existingToken,
      });
      expect(existingAccepted.joined).toBe(true);
      expect(existingAccepted.membership.role).toBe("editor");
      await expect(
        memberships.accept({ principal: principal(existingInviteeId), token: existingToken }),
      ).rejects.toMatchObject({
        safeResponse: { code: "CONFLICT" },
      });
      await expect(
        memberships.revoke({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          invitationId: existingInvite.invitation.id,
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "CONFLICT" } });
      await expect(
        memberships.resend({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          invitationId: existingInvite.invitation.id,
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "CONFLICT" } });

      // Registration may happen after invitation creation; acceptance uses the
      // now-authenticated user's normalized authoritative email.
      await db.insert(users).values({
        id: unregisteredInviteeId,
        email: unregisteredEmail,
        name: "Registered after invite",
      });
      const unregisteredAccepted = await memberships.accept({
        principal: principal(unregisteredInviteeId),
        token: tokens.derive(unregisteredInvite.invitation.id),
      });
      expect(unregisteredAccepted.membership.email).toBe(unregisteredEmail);

      // A membership created by a concurrent administrative path is retained;
      // accepting the still-pending invite consumes it without overwriting role.
      const racedInvite = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: racedEmail,
        role: "viewer",
      });
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: alphaWorkspaceId,
        userId: racedInviteeId,
        role: "editor",
      });
      const racedAccepted = await memberships.accept({
        principal: principal(racedInviteeId),
        token: tokens.derive(racedInvite.invitation.id),
      });
      expect(racedAccepted.joined).toBe(false);
      expect(racedAccepted.membership.role).toBe("editor");

      // Expired and revoked tokens are rejected without changing membership.
      const expired = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: expiredEmail,
        role: "viewer",
      });
      await db
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(invitations.id, expired.invitation.id));
      await expect(
        memberships.accept({
          principal: principal(expiredInviteeId),
          token: tokens.derive(expired.invitation.id),
        }),
      ).rejects.toMatchObject({
        safeResponse: { code: "CONFLICT" },
      });
      const revoked = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: revokedEmail,
        role: "viewer",
      });
      await memberships.revoke({
        principal: admin,
        workspaceId: alphaWorkspaceId,
        invitationId: revoked.invitation.id,
      });
      await expect(
        memberships.accept({
          principal: principal(revokedInviteeId),
          token: tokens.derive(revoked.invitation.id),
        }),
      ).rejects.toMatchObject({
        safeResponse: { code: "CONFLICT" },
      });

      // Role cap and self-escalation are service-enforced in addition to policy.
      await expect(
        memberships.invite({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          email: `owner-target-${suffix}@example.test`,
          role: "owner",
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "FORBIDDEN" } });
      await expect(
        memberships.invite({
          principal: editor,
          workspaceId: alphaWorkspaceId,
          email: `editor-target-${suffix}@example.test`,
          role: "viewer",
        }),
      ).rejects.toBeDefined();
      await expect(
        memberships.changeRole({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          memberId: adminMemberId,
          role: "owner",
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "FORBIDDEN" } });
      await expect(
        memberships.changeRole({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          memberId: ownerMemberId,
          role: "admin",
        }),
      ).rejects.toBeDefined();
      await expect(
        memberships.changeRole({
          principal: owner,
          workspaceId: alphaWorkspaceId,
          memberId: betaOwnerMemberId,
          role: "viewer",
        }),
      ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

      // Last-owner demotion and leave remain impossible in the same locked transaction.
      await expect(
        memberships.changeRole({
          principal: owner,
          workspaceId: alphaWorkspaceId,
          memberId: ownerMemberId,
          role: "admin",
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "CONFLICT" } });
      await expect(
        memberships.leave({ principal: owner, workspaceId: alphaWorkspaceId }),
      ).rejects.toMatchObject({
        safeResponse: { code: "CONFLICT" },
      });

      // Resend revokes the old row and creates a new UUID/hash and idempotency key.
      const resendSource = await memberships.invite({
        principal: admin,
        workspaceId: alphaWorkspaceId,
        email: `resend-${suffix}@example.test`,
        role: "viewer",
      });
      const [sourceBefore] = await db
        .select({ tokenHash: invitations.tokenHash })
        .from(invitations)
        .where(eq(invitations.id, resendSource.invitation.id));
      const resent = await memberships.resend({
        principal: admin,
        workspaceId: alphaWorkspaceId,
        invitationId: resendSource.invitation.id,
      });
      const [sourceAfter] = await db
        .select({ revokedAt: invitations.revokedAt })
        .from(invitations)
        .where(eq(invitations.id, resendSource.invitation.id));
      const [replacement] = await db
        .select({ tokenHash: invitations.tokenHash })
        .from(invitations)
        .where(eq(invitations.id, resent.invitation.id));
      expect(resent.invitation.id).not.toBe(resendSource.invitation.id);
      expect(sourceAfter?.revokedAt).not.toBeNull();
      expect(replacement?.tokenHash).not.toBe(sourceBefore?.tokenHash);

      // A same-tenant actor cannot use a guessed cross-tenant invitation id.
      const betaInvite = await memberships.invite({
        principal: principal(betaOwnerId),
        workspaceId: betaWorkspaceId,
        email: `beta-target-${suffix}@example.test`,
        role: "viewer",
      });
      await expect(
        memberships.resend({
          principal: owner,
          workspaceId: alphaWorkspaceId,
          invitationId: betaInvite.invitation.id,
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

      const membersPage = await memberships.listMembers({
        principal: editor,
        workspaceId: alphaWorkspaceId,
        page: 1,
        limit: 100,
      });
      await expect(
        memberships.listInvitations({
          principal: editor,
          workspaceId: alphaWorkspaceId,
          page: 1,
          limit: 100,
        }),
      ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });
      const invitationsPage = await memberships.listInvitations({
        principal: admin,
        workspaceId: alphaWorkspaceId,
        page: 1,
        limit: 100,
      });
      expect(membersPage.items.every((item) => item.workspaceId === alphaWorkspaceId)).toBe(true);
      expect(invitationsPage.items.every((item) => item.workspaceId === alphaWorkspaceId)).toBe(
        true,
      );
      expect(invitationsPage.items.some((item) => "tokenHash" in item)).toBe(false);

      const terminalRace = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: terminalRaceEmail,
        role: "viewer",
      });
      const acceptVsRevoke = await Promise.allSettled([
        memberships.accept({
          principal: principal(terminalRaceInviteeId),
          token: tokens.derive(terminalRace.invitation.id),
        }),
        memberships.revoke({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          invitationId: terminalRace.invitation.id,
        }),
      ]);
      expect(acceptVsRevoke.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const [terminalRaceRow] = await db
        .select({ acceptedAt: invitations.acceptedAt, revokedAt: invitations.revokedAt })
        .from(invitations)
        .where(eq(invitations.id, terminalRace.invitation.id));
      expect(
        Number(terminalRaceRow?.acceptedAt instanceof Date) +
          Number(terminalRaceRow?.revokedAt instanceof Date),
      ).toBe(1);

      const resendRace = await memberships.invite({
        principal: owner,
        workspaceId: alphaWorkspaceId,
        email: resendRaceEmail,
        role: "viewer",
      });
      const acceptVsResend = await Promise.allSettled([
        memberships.accept({
          principal: principal(resendRaceInviteeId),
          token: tokens.derive(resendRace.invitation.id),
        }),
        memberships.resend({
          principal: admin,
          workspaceId: alphaWorkspaceId,
          invitationId: resendRace.invitation.id,
        }),
      ]);
      expect(acceptVsResend.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const [resendRaceSource] = await db
        .select({ acceptedAt: invitations.acceptedAt, revokedAt: invitations.revokedAt })
        .from(invitations)
        .where(eq(invitations.id, resendRace.invitation.id));
      expect(
        Number(resendRaceSource?.acceptedAt instanceof Date) +
          Number(resendRaceSource?.revokedAt instanceof Date),
      ).toBe(1);

      const invitationIds = [
        existingInvite.invitation.id,
        unregisteredInvite.invitation.id,
        resent.invitation.id,
      ];
      const persistedInvites = await db
        .select()
        .from(invitations)
        .where(inArray(invitations.id, invitationIds));
      const deliveryRows = await db
        .select()
        .from(emailDeliveries)
        .where(eq(emailDeliveries.workspaceId, alphaWorkspaceId));
      const outboxRows = await db
        .select()
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.workspaceId, alphaWorkspaceId),
            eq(jobOutbox.jobType, INVITATION_EMAIL_JOB_TYPE),
          ),
        );
      const auditRows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.workspaceId, alphaWorkspaceId));
      expect(deliveryRows.length).toBeGreaterThanOrEqual(invitationIds.length);
      expect(outboxRows.length).toBe(deliveryRows.length);
      expect(auditRows.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "member.invite",
          "invitation.accept",
          "invitation.resend",
          "invitation.revoke",
        ]),
      );
      for (const invitation of persistedInvites) {
        const rawToken = tokens.derive(invitation.id);
        expect(invitation.tokenHash).toBe(tokens.hash(rawToken));
        expect(
          JSON.stringify({
            invitation,
            outboxRows,
            auditRows,
            api: [existingInvite, unregisteredInvite, resent],
          }),
        ).not.toContain(rawToken);
      }
    } finally {
      await db
        .delete(jobOutbox)
        .where(inArray(jobOutbox.workspaceId, fixtureWorkspaceIds))
        .catch(() => undefined);
      await db
        .delete(workspaces)
        .where(inArray(workspaces.id, fixtureWorkspaceIds))
        .catch(() => undefined);
      await db
        .delete(users)
        .where(inArray(users.id, fixtureUserIds))
        .catch(() => undefined);
    }
  });

  it("serializes concurrent owner demotion, removal, and leave so each workspace retains an owner", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    const fixtureWorkspaceIds: string[] = [];
    const fixtureUserIds: string[] = [];
    const suffix = randomUUID().slice(0, 8);

    async function twoOwnerWorkspace(label: string): Promise<{
      workspaceId: string;
      firstUserId: string;
      secondUserId: string;
      firstMemberId: string;
      secondMemberId: string;
    }> {
      const workspaceId = randomUUID();
      const firstUserId = randomUUID();
      const secondUserId = randomUUID();
      const firstMemberId = randomUUID();
      const secondMemberId = randomUUID();
      fixtureWorkspaceIds.push(workspaceId);
      fixtureUserIds.push(firstUserId, secondUserId);
      await db!.insert(users).values([
        { id: firstUserId, email: `${label}-a-${suffix}@example.test`, name: `${label} A` },
        { id: secondUserId, email: `${label}-b-${suffix}@example.test`, name: `${label} B` },
      ]);
      await db!.insert(workspaces).values({
        id: workspaceId,
        name: `Part 28 ${label}`,
        slug: `part-28-${label}-${suffix}`,
        createdById: firstUserId,
      });
      await db!.insert(workspaceMembers).values([
        { id: firstMemberId, workspaceId, userId: firstUserId, role: "owner" },
        { id: secondMemberId, workspaceId, userId: secondUserId, role: "owner" },
      ]);
      return { workspaceId, firstUserId, secondUserId, firstMemberId, secondMemberId };
    }

    try {
      const demote = await twoOwnerWorkspace("demote");
      const remove = await twoOwnerWorkspace("remove");
      const leave = await twoOwnerWorkspace("leave");
      const { memberships } = service();

      const demotions = await Promise.allSettled([
        memberships.changeRole({
          principal: principal(demote.firstUserId),
          workspaceId: demote.workspaceId,
          memberId: demote.secondMemberId,
          role: "viewer",
        }),
        memberships.changeRole({
          principal: principal(demote.secondUserId),
          workspaceId: demote.workspaceId,
          memberId: demote.firstMemberId,
          role: "viewer",
        }),
      ]);
      const removals = await Promise.allSettled([
        memberships.remove({
          principal: principal(remove.firstUserId),
          workspaceId: remove.workspaceId,
          memberId: remove.secondMemberId,
        }),
        memberships.remove({
          principal: principal(remove.secondUserId),
          workspaceId: remove.workspaceId,
          memberId: remove.firstMemberId,
        }),
      ]);
      const leaves = await Promise.allSettled([
        memberships.leave({
          principal: principal(leave.firstUserId),
          workspaceId: leave.workspaceId,
        }),
        memberships.leave({
          principal: principal(leave.secondUserId),
          workspaceId: leave.workspaceId,
        }),
      ]);

      for (const outcomes of [demotions, removals, leaves]) {
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      }
      for (const workspaceId of fixtureWorkspaceIds) {
        const owners = await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(
            and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")),
          );
        expect(owners).toHaveLength(1);
      }
    } finally {
      await db
        .delete(jobOutbox)
        .where(inArray(jobOutbox.workspaceId, fixtureWorkspaceIds))
        .catch(() => undefined);
      await db
        .delete(workspaces)
        .where(inArray(workspaces.id, fixtureWorkspaceIds))
        .catch(() => undefined);
      await db
        .delete(users)
        .where(inArray(users.id, fixtureUserIds))
        .catch(() => undefined);
    }
  });
});
