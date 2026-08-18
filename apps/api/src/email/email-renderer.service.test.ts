import { describe, expect, it } from "vitest";

import { DEFAULT_ACCENT_COLOR, PLATFORM_BRANDING_NAME } from "./email-branding";
import { EmailRendererService } from "./email-renderer.service";
import { EMAIL_TEMPLATE_KEYS } from "./email-templates";

import type { EmailBranding } from "./email-branding";
import type { EmailTemplateKey, EmailTemplateProps } from "./email-templates";

const branding: EmailBranding = {
  name: PLATFORM_BRANDING_NAME,
  logoUrl: null,
  accentColor: DEFAULT_ACCENT_COLOR,
  appUrl: "https://app.notted.test",
};

/**
 * Exhaustive by construction: a new `EmailTemplateKey` fails to compile here
 * until it gets props, so the coverage loop below can never silently skip one.
 */
const props: { readonly [K in EmailTemplateKey]: EmailTemplateProps[K] } = {
  welcome: { branding, recipientName: "Ada" },
  registration_verification: { branding, actionUrl: "https://app.notted.test/verify?token=a" },
  verification_resend: { branding, actionUrl: "https://app.notted.test/verify?token=b" },
  magic_link: { branding, actionUrl: "https://app.notted.test/magic?token=c" },
  password_reset_request: { branding, actionUrl: "https://app.notted.test/reset?token=d" },
  password_reset_confirmation: { branding },
  invitation: { branding, workspaceName: "Acme", actionUrl: "https://app.notted.test/invite/e" },
  mention: {
    branding,
    actorName: "Ada",
    noteTitle: "Q3 plan",
    noteUrl: "https://app.notted.test/notes/1",
    preferenceUrl: "https://app.notted.test/settings/notifications",
  },
  export_ready: {
    branding,
    format: "PDF",
    exportUrl: "https://app.notted.test/exports/1",
    subjectLabel: "Q3 plan",
  },
};

describe("EmailRendererService", () => {
  const service = new EmailRendererService();

  it.each(EMAIL_TEMPLATE_KEYS)("renders a complete message for %s", async (key) => {
    const message = await service.render(key, props[key]);
    expect(message.subject.length).toBeGreaterThan(0);
    expect(message.html.length).toBeGreaterThan(0);
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.html).toContain('<html lang="en">');
  });

  it("preserves the verbatim authentication subjects", async () => {
    const subjectOf = async (key: EmailTemplateKey): Promise<string> =>
      (await service.render(key, props[key])).subject;
    expect(await subjectOf("registration_verification")).toBe("Verify your Notted email");
    expect(await subjectOf("verification_resend")).toBe("Verify your Notted email");
    expect(await subjectOf("magic_link")).toBe("Your Notted magic link");
    expect(await subjectOf("password_reset_request")).toBe("Reset your Notted password");
    expect(await subjectOf("password_reset_confirmation")).toBe("Your Notted password was reset");
  });

  it("preserves the verbatim invitation subject", async () => {
    const message = await service.render("invitation", props.invitation);
    expect(message.subject).toBe("Join Acme on Notted");
  });

  it("uses the exact mention subject shape", async () => {
    const message = await service.render("mention", props.mention);
    expect(message.subject).toBe('Ada mentioned you in "Q3 plan"');
  });

  it("escapes workspace-controlled markup in the invitation body", async () => {
    const message = await service.render("invitation", {
      ...props.invitation,
      workspaceName: "<script>alert(1)</script>",
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("escapes user-controlled markup in the mention body", async () => {
    const message = await service.render("mention", {
      ...props.mention,
      actorName: "<img src=x onerror=alert(1)>",
      noteTitle: "<script>alert(2)</script>",
    });
    // The assertion is that no injected TAG survives, not that the payload text
    // is gone: `onerror=alert(1)` is required to appear, escaped, two lines
    // down. So assert the tag openers — what would actually execute — and scope
    // the `img` one to the injected form, because the layout legitimately emits
    // its own `<img>` when the branding carries a logo URL.
    expect(message.html).not.toContain("<script");
    expect(message.html).not.toContain("<img src=x");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders the reset confirmation without any action link", async () => {
    const message = await service.render(
      "password_reset_confirmation",
      props.password_reset_confirmation,
    );
    expect(message.text).toContain("was reset");
    expect(message.html).not.toContain("href=");
  });

  it("rejects a template key outside the union", async () => {
    // Simulates a corrupt or retired `email_deliveries.template_key` varchar.
    const corrupted = "not_a_template" as EmailTemplateKey;
    await expect(service.render(corrupted, props.welcome)).rejects.toThrow(
      "Unknown email template key",
    );
  });
});
