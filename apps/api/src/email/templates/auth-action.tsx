// Part 61 — the four token-bearing authentication emails.
//
// Subjects are VERBATIM the strings `AuthEmailQueueHandler` sends today, so
// moving to the renderer is behaviour-preserving for mailbox threading and for
// anyone filtering on them.

import { EmailButton, EmailFallbackUrl, EmailLayout, EmailParagraph } from "./layout";

import type { AuthActionEmailProps } from "../email-templates";
import type { JSX } from "react";

export type AuthActionPurpose =
  "registration_verification" | "verification_resend" | "magic_link" | "password_reset_request";

export type AuthActionTemplateProps = AuthActionEmailProps & {
  readonly purpose: AuthActionPurpose;
};

interface AuthActionCopy {
  readonly subject: string;
  readonly heading: string;
  readonly body: string;
  readonly buttonLabel: string;
}

const COPY: Record<AuthActionPurpose, AuthActionCopy> = {
  registration_verification: {
    subject: "Verify your Notted email",
    heading: "Verify your email",
    body: "Confirm this address to finish setting up your Notted account.",
    buttonLabel: "Verify email",
  },
  verification_resend: {
    subject: "Verify your Notted email",
    heading: "Verify your email",
    body: "Here is a fresh verification link for your Notted account.",
    buttonLabel: "Verify email",
  },
  magic_link: {
    subject: "Your Notted magic link",
    heading: "Sign in to Notted",
    body: "Use the link below to sign in. If you did not ask to sign in, ignore this email.",
    buttonLabel: "Sign in",
  },
  password_reset_request: {
    subject: "Reset your Notted password",
    heading: "Reset your password",
    body: "Use the link below to choose a new password. Your current password stays active until you do.",
    buttonLabel: "Reset password",
  },
};

export function AuthActionSubject(props: AuthActionTemplateProps): string {
  return COPY[props.purpose].subject;
}

export function AuthActionEmail(props: AuthActionTemplateProps): JSX.Element {
  const copy = COPY[props.purpose];
  return (
    <EmailLayout branding={props.branding} preview={copy.body} heading={copy.heading}>
      <EmailParagraph>{copy.body}</EmailParagraph>
      <EmailButton
        href={props.actionUrl}
        label={copy.buttonLabel}
        accentColor={props.branding.accentColor}
      />
      <EmailFallbackUrl url={props.actionUrl} />
      <EmailParagraph>This link is single-use and expires soon.</EmailParagraph>
    </EmailLayout>
  );
}
