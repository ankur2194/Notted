// Part 61 — workspace invitation. Subject is VERBATIM what
// `InvitationEmailWorkerService` sends today, so the migration is invisible to
// recipients and to their mail filters.

import { EmailButton, EmailFallbackUrl, EmailLayout, EmailParagraph } from "./layout";

import type { InvitationEmailProps } from "../email-templates";
import type { JSX } from "react";

export function InvitationSubject(props: InvitationEmailProps): string {
  return `Join ${props.workspaceName} on Notted`;
}

export function InvitationEmail(props: InvitationEmailProps): JSX.Element {
  return (
    <EmailLayout
      branding={props.branding}
      preview={`You were invited to join ${props.workspaceName} on Notted.`}
      heading={`Join ${props.workspaceName}`}
    >
      <EmailParagraph>
        {"You were invited to join "}
        <strong>{props.workspaceName}</strong>
        {" on Notted."}
      </EmailParagraph>
      <EmailButton
        href={props.actionUrl}
        label="Accept invitation"
        accentColor={props.branding.accentColor}
      />
      <EmailFallbackUrl url={props.actionUrl} />
      <EmailParagraph>This link is single-use and expires in seven days.</EmailParagraph>
    </EmailLayout>
  );
}
