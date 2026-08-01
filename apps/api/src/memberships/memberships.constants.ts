export const MEMBERSHIP_AUDIT_ACTIONS = Object.freeze({
  invite: "member.invite",
  accept: "invitation.accept",
  resend: "invitation.resend",
  revoke: "invitation.revoke",
  roleChange: "member.role.change",
  remove: "member.remove",
  leave: "member.leave",
} as const);

export const INVITATION_EMAIL_QUEUE_NAME = "transactional-email" as const;
export const INVITATION_EMAIL_JOB_TYPE = "workspace.invitation.send" as const;
export const INVITATION_EMAIL_PAYLOAD_VERSION = 1 as const;
export const INVITATION_EMAIL_IDEMPOTENCY_PREFIX = "workspace-invitation-send:" as const;
export const INVITATION_EMAIL_TEMPLATE_KEY = "workspace-invitation" as const;
export const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;

export const ROLE_RANK = Object.freeze({ viewer: 0, editor: 1, admin: 2, owner: 3 } as const);
