// Part 61 — the template contract shared by the renderer, the templates, and
// every producer.
//
// TEMPLATE KEYS ARE PERSISTED. `email_deliveries.template_key` is a plain
// varchar(100) and already holds the five `AuthEmailPurpose` values written by
// `AuthEmailProducerService` (`templateKey: input.purpose`). Those five appear
// here VERBATIM so the generic renderer keys off exactly what is already in the
// table: no data migration, no enum change, no backfill.

import type { EmailBranding } from "./email-branding";

export const EMAIL_TEMPLATE_KEYS = [
  "welcome",
  "registration_verification",
  "verification_resend",
  "magic_link",
  "password_reset_request",
  "password_reset_confirmation",
  "invitation",
  "mention",
  "export_ready",
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export function isEmailTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** Exactly the shape `SmtpService.send` consumes, minus the recipient. */
export interface EmailMessage {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface BrandedProps {
  readonly branding: EmailBranding;
}

/** Verification, resend, magic link and reset-request all share this shape. */
export interface AuthActionEmailProps extends BrandedProps {
  /** Single-use, short-lived URL. NEVER logged and NEVER persisted. */
  readonly actionUrl: string;
}

export type PasswordResetConfirmationEmailProps = BrandedProps;

export interface WelcomeEmailProps extends BrandedProps {
  /** Display name, or `null` when registration captured none. */
  readonly recipientName: string | null;
}

export interface InvitationEmailProps extends BrandedProps {
  readonly workspaceName: string;
  readonly actionUrl: string;
}

export interface MentionEmailProps extends BrandedProps {
  readonly actorName: string;
  readonly noteTitle: string;
  /** Login-gated app URL for the note. */
  readonly noteUrl: string;
  /** Login-gated preference page. Never a one-click unsubscribe token. */
  readonly preferenceUrl: string;
}

export interface ExportReadyEmailProps extends BrandedProps {
  /** Human-facing format label, e.g. "PDF". */
  readonly format: string;
  /**
   * Login-gated app URL for the finished export. NEVER an embedded signed URL:
   * a mailbox is persistence and ADR 0005 keeps signed URLs out of it.
   */
  readonly exportUrl: string;
  /** What was exported, e.g. a note title or "Workspace". */
  readonly subjectLabel: string;
}

/** Key -> props. `EmailRendererService.render` is typed against this map. */
export interface EmailTemplateProps {
  readonly welcome: WelcomeEmailProps;
  readonly registration_verification: AuthActionEmailProps;
  readonly verification_resend: AuthActionEmailProps;
  readonly magic_link: AuthActionEmailProps;
  readonly password_reset_request: AuthActionEmailProps;
  readonly password_reset_confirmation: PasswordResetConfirmationEmailProps;
  readonly invitation: InvitationEmailProps;
  readonly mention: MentionEmailProps;
  readonly export_ready: ExportReadyEmailProps;
}
