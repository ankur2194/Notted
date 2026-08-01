import { describe, expect, it } from "vitest";

import {
  acceptWorkspaceInvitationSchema,
  changeWorkspaceMemberRoleSchema,
  invitationListQuerySchema,
  inviteWorkspaceMemberSchema,
  membershipListQuerySchema,
  workspaceInvitationSummarySchema,
  workspaceMemberPageSchema,
} from "./workspace.schema";

const id = "20000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-01T12:00:00.000Z";

describe("Part 28 membership validators", () => {
  it("normalizes an invitation email and defaults the role", () => {
    expect(inviteWorkspaceMemberSchema.parse({ email: "  Person@Example.COM " })).toEqual({
      email: "person@example.com",
      role: "viewer",
    });
  });

  it("accepts every role and rejects malformed email, unknown roles, and extra fields", () => {
    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      expect(inviteWorkspaceMemberSchema.parse({ email: "person@example.com", role }).role).toBe(
        role,
      );
    }
    expect(inviteWorkspaceMemberSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(
      inviteWorkspaceMemberSchema.safeParse({ email: "p@example.com", role: "superadmin" }).success,
    ).toBe(false);
    expect(
      inviteWorkspaceMemberSchema.safeParse({ email: "p@example.com", extra: true }).success,
    ).toBe(false);
  });

  it("enforces the deterministic token boundary without coercion or extra keys", () => {
    const token = "A".repeat(43);
    expect(acceptWorkspaceInvitationSchema.parse({ token })).toEqual({ token });
    expect(acceptWorkspaceInvitationSchema.safeParse({ token: "A".repeat(42) }).success).toBe(
      false,
    );
    expect(acceptWorkspaceInvitationSchema.safeParse({ token: `${"A".repeat(42)}+` }).success).toBe(
      false,
    );
    expect(acceptWorkspaceInvitationSchema.safeParse({ token, extra: true }).success).toBe(false);
  });

  it("coerces bounded pagination query strings but rejects excessive and ambiguous values", () => {
    expect(membershipListQuerySchema.parse({ page: "2", limit: "100" })).toEqual({
      page: 2,
      limit: 100,
    });
    expect(invitationListQuerySchema.parse({ status: "pending" })).toEqual({
      page: 1,
      limit: 25,
      status: "pending",
    });
    expect(membershipListQuerySchema.safeParse({ page: "10001" }).success).toBe(false);
    expect(membershipListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(membershipListQuerySchema.safeParse({ page: "01" }).success).toBe(false);
    expect(invitationListQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
  });

  it("validates strict member and invitation output contracts and excludes tokenHash", () => {
    const member = {
      id,
      workspaceId: id,
      userId: id,
      name: "Person",
      email: "person@example.com",
      role: "editor",
      joinedAt: timestamp,
    };
    expect(
      workspaceMemberPageSchema.parse({ items: [member], page: 1, limit: 25, hasMore: false })
        .items,
    ).toHaveLength(1);
    expect(changeWorkspaceMemberRoleSchema.safeParse({ role: "admin", extra: true }).success).toBe(
      false,
    );
    expect(
      workspaceInvitationSummarySchema.safeParse({
        id,
        workspaceId: id,
        email: "person@example.com",
        role: "viewer",
        status: "pending",
        invitedById: id,
        acceptedById: null,
        expiresAt: timestamp,
        acceptedAt: null,
        revokedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        tokenHash: "must-not-be-public",
      }).success,
    ).toBe(false);
  });
});
