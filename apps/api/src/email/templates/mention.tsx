// Part 61 — mention notification. Subject shape is fixed by Notted.md:1211.
//
// `noteUrl` and `preferenceUrl` are login-gated app pages, never one-click
// tokens: a mailbox is persistence and must not carry an authorisation bearer.

import { EmailButton, EmailLayout, EmailParagraph } from "./layout";

import type { MentionEmailProps } from "../email-templates";
import type { JSX } from "react";

export function MentionSubject(props: MentionEmailProps): string {
  return `${props.actorName} mentioned you in "${props.noteTitle}"`;
}

export function MentionEmail(props: MentionEmailProps): JSX.Element {
  return (
    <EmailLayout
      branding={props.branding}
      preview={`${props.actorName} mentioned you in ${props.noteTitle}.`}
      heading="You were mentioned"
      footerNote="You get this because you were mentioned in a note you can access."
      footerLink={{ url: props.preferenceUrl, label: "Manage email preferences" }}
    >
      <EmailParagraph>
        <strong>{props.actorName}</strong>
        {" mentioned you in "}
        <strong>{props.noteTitle}</strong>
        {"."}
      </EmailParagraph>
      <EmailButton
        href={props.noteUrl}
        label="Open the note"
        accentColor={props.branding.accentColor}
      />
    </EmailLayout>
  );
}
