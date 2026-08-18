// Part 61 — export-ready notification (consumed by Part 62).
//
// IMPORTANT: `exportUrl` is a login-gated app page, NOT a download link.
// A signed object-storage URL must NEVER be embedded here: a mailbox is
// persistence, and ADR 0005 keeps expiring signed URLs out of anything
// persisted. The recipient authenticates, then the app mints the signed URL.

import { EmailButton, EmailLayout, EmailParagraph } from "./layout";

import type { ExportReadyEmailProps } from "../email-templates";
import type { JSX } from "react";

export function ExportReadySubject(props: ExportReadyEmailProps): string {
  return `Your ${props.format} export is ready`;
}

export function ExportReadyEmail(props: ExportReadyEmailProps): JSX.Element {
  return (
    <EmailLayout
      branding={props.branding}
      preview={`Your ${props.format} export of ${props.subjectLabel} is ready.`}
      heading={`Your ${props.format} export is ready`}
    >
      <EmailParagraph>
        {`Your ${props.format} export of `}
        <strong>{props.subjectLabel}</strong>
        {" has finished."}
      </EmailParagraph>
      <EmailButton
        href={props.exportUrl}
        label="Open your export"
        accentColor={props.branding.accentColor}
      />
      <EmailParagraph>
        Sign in to download it. Exports are removed after they expire.
      </EmailParagraph>
    </EmailLayout>
  );
}
