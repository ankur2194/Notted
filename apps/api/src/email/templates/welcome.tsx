// Part 61 — first-run welcome. Carries no token and no action URL.

import { EmailLayout, EmailParagraph } from "./layout";

import type { WelcomeEmailProps } from "../email-templates";
import type { JSX } from "react";

export function WelcomeSubject(props: WelcomeEmailProps): string {
  return `Welcome to ${props.branding.name}`;
}

export function WelcomeEmail(props: WelcomeEmailProps): JSX.Element {
  const name = props.recipientName?.trim() ?? "";
  const greeting = name === "" ? "Welcome to Notted." : `Welcome to Notted, ${name}.`;
  return (
    <EmailLayout
      branding={props.branding}
      preview={greeting}
      heading={`Welcome to ${props.branding.name}`}
      footerLink={{ url: props.branding.appUrl, label: "Open Notted" }}
    >
      <EmailParagraph>{greeting}</EmailParagraph>
      <EmailParagraph>
        Your account is ready. Create a note, invite your team, and everything stays organised in
        your workspace.
      </EmailParagraph>
    </EmailLayout>
  );
}
