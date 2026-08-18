// Part 61 — the single place a template key becomes an `EmailMessage`.
//
// Pure by construction: no database, no config, no logging, no I/O. It is
// `@Injectable()` only so Nest can hand the same instance to every queue
// handler. Rendered bodies, action URLs and recipients are never logged here.

import { Injectable } from "@nestjs/common";
import { render } from "@react-email/render";

import { isEmailTemplateKey } from "./email-templates";
import { AuthActionEmail, AuthActionSubject } from "./templates/auth-action";
import { ExportReadyEmail, ExportReadySubject } from "./templates/export-ready";
import { InvitationEmail, InvitationSubject } from "./templates/invitation";
import { PREHEADER_ELEMENT_ID } from "./templates/layout";
import { MentionEmail, MentionSubject } from "./templates/mention";
import {
  PasswordResetConfirmationEmail,
  PasswordResetConfirmationSubject,
} from "./templates/password-reset-confirmation";
import { WelcomeEmail, WelcomeSubject } from "./templates/welcome";

import type { EmailMessage, EmailTemplateKey, EmailTemplateProps } from "./email-templates";
import type { AuthActionPurpose } from "./templates/auth-action";
import type { JSX } from "react";

interface TemplateDefinition<TKey extends EmailTemplateKey> {
  readonly subject: (props: EmailTemplateProps[TKey]) => string;
  readonly element: (props: EmailTemplateProps[TKey]) => JSX.Element;
}

type TemplateRegistry = { readonly [K in EmailTemplateKey]: TemplateDefinition<K> };

/** The four auth templates differ only by copy, selected by `purpose`. */
function authTemplate(purpose: AuthActionPurpose): TemplateDefinition<AuthActionPurpose> {
  return {
    subject: (props) => AuthActionSubject({ ...props, purpose }),
    element: (props) => AuthActionEmail({ ...props, purpose }),
  };
}

const TEMPLATES: TemplateRegistry = {
  welcome: { subject: WelcomeSubject, element: WelcomeEmail },
  registration_verification: authTemplate("registration_verification"),
  verification_resend: authTemplate("verification_resend"),
  magic_link: authTemplate("magic_link"),
  password_reset_request: authTemplate("password_reset_request"),
  password_reset_confirmation: {
    subject: PasswordResetConfirmationSubject,
    element: PasswordResetConfirmationEmail,
  },
  invitation: { subject: InvitationSubject, element: InvitationEmail },
  mention: { subject: MentionSubject, element: MentionEmail },
  export_ready: { subject: ExportReadySubject, element: ExportReadyEmail },
};

@Injectable()
export class EmailRendererService {
  async render<TKey extends EmailTemplateKey>(
    templateKey: TKey,
    props: EmailTemplateProps[TKey],
  ): Promise<EmailMessage> {
    // `email_deliveries.template_key` is a plain varchar, so a corrupt or
    // retired row can hand us a string outside the union. Guard at runtime.
    if (!isEmailTemplateKey(templateKey)) {
      throw new Error(`Unknown email template key: ${String(templateKey)}`);
    }
    const template: TemplateDefinition<TKey> = TEMPLATES[templateKey];
    const element = template.element(props);
    const [html, text] = await Promise.all([
      render(element),
      render(element, {
        plainText: true,
        htmlToTextOptions: {
          selectors: [{ selector: `#${PREHEADER_ELEMENT_ID}`, format: "skip" }],
        },
      }),
    ]);
    return Object.freeze({ subject: template.subject(props), html, text });
  }
}
