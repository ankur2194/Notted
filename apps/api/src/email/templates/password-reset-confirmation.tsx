// Part 61 — post-reset notification. There is no action URL and there must
// never be one: this email is the audit trail, not a credential carrier.

import { EmailLayout, EmailParagraph } from "./layout";

import type { PasswordResetConfirmationEmailProps } from "../email-templates";
import type { JSX } from "react";

const BODY = "Your Notted password was reset. If this was not you, contact your administrator.";

export function PasswordResetConfirmationSubject(): string {
  return "Your Notted password was reset";
}

export function PasswordResetConfirmationEmail(
  props: PasswordResetConfirmationEmailProps,
): JSX.Element {
  return (
    <EmailLayout branding={props.branding} preview={BODY} heading="Your password was reset">
      <EmailParagraph>{BODY}</EmailParagraph>
    </EmailLayout>
  );
}
