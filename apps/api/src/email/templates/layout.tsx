// Part 61 — the one shared chrome every Notted email is rendered into.
//
// Deliberately hand-written table markup with inline styles: Outlook and
// friends drop `<style>` blocks, flexbox and grid, so nothing here relies on
// them. No web fonts, no external CSS, no remote assets beyond the workspace
// logo the branding resolver already validated.

import type { EmailBranding } from "../email-branding";
import type { JSX, ReactNode } from "react";

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const PAGE_BACKGROUND = "#f4f5f7";
const SURFACE = "#ffffff";
const TEXT_COLOR = "#111827";
const MUTED_COLOR = "#6b7280";
const BORDER_COLOR = "#e5e7eb";

const tableReset = { role: "presentation", cellPadding: 0, cellSpacing: 0, border: 0 } as const;

/**
 * The preheader is visually hidden but html-to-text cannot see `display:none`,
 * so the plain-text renderer skips it by id instead of repeating the sentence.
 */
export const PREHEADER_ELEMENT_ID = "preheader";

export interface EmailLayoutProps {
  readonly branding: EmailBranding;
  /** Preheader text: the snippet mail clients show next to the subject. */
  readonly preview: string;
  readonly heading: string;
  readonly children: ReactNode;
  readonly footerNote?: string;
  readonly footerLink?: { readonly url: string; readonly label: string };
}

export function EmailLayout(props: EmailLayoutProps): JSX.Element {
  const { branding, preview, heading, children, footerNote, footerLink } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{heading}</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: PAGE_BACKGROUND,
          color: TEXT_COLOR,
          fontFamily: FONT_STACK,
        }}
      >
        <div
          id={PREHEADER_ELEMENT_ID}
          style={{
            display: "none",
            overflow: "hidden",
            lineHeight: "1px",
            maxHeight: 0,
            opacity: 0,
          }}
        >
          {preview}
        </div>
        <table {...tableReset} width="100%" style={{ backgroundColor: PAGE_BACKGROUND }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: "24px 12px" }}>
                <table {...tableReset} width="100%" style={{ maxWidth: "600px" }}>
                  <tbody>
                    <tr>
                      <td style={{ padding: "0 0 16px 0" }}>
                        {branding.logoUrl === null ? (
                          <span
                            style={{
                              fontSize: "20px",
                              fontWeight: 700,
                              color: branding.accentColor,
                            }}
                          >
                            {branding.name}
                          </span>
                        ) : (
                          <img
                            src={branding.logoUrl}
                            alt={branding.name}
                            height={40}
                            style={{ display: "block", border: 0 }}
                          />
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{
                          backgroundColor: SURFACE,
                          border: `1px solid ${BORDER_COLOR}`,
                          borderRadius: "8px",
                          padding: "32px",
                        }}
                      >
                        <h1
                          style={{
                            margin: "0 0 16px 0",
                            fontSize: "22px",
                            lineHeight: "30px",
                            fontWeight: 700,
                            color: TEXT_COLOR,
                          }}
                        >
                          {heading}
                        </h1>
                        {children}
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{
                          padding: "20px 8px 0 8px",
                          fontSize: "12px",
                          lineHeight: "18px",
                          color: MUTED_COLOR,
                        }}
                      >
                        {footerNote === undefined ? null : (
                          <p style={{ margin: "0 0 8px 0" }}>{footerNote}</p>
                        )}
                        {footerLink === undefined ? null : (
                          <p style={{ margin: "0 0 8px 0" }}>
                            <a href={footerLink.url} style={{ color: MUTED_COLOR }}>
                              {footerLink.label}
                            </a>
                          </p>
                        )}
                        <p style={{ margin: 0 }}>Sent by Notted.</p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

export function EmailButton(props: {
  readonly href: string;
  readonly label: string;
  readonly accentColor: string;
}): JSX.Element {
  return (
    <table {...tableReset} style={{ margin: "24px 0" }}>
      <tbody>
        <tr>
          <td style={{ borderRadius: "6px", backgroundColor: props.accentColor }}>
            <a
              href={props.href}
              style={{
                display: "inline-block",
                padding: "12px 24px",
                fontFamily: FONT_STACK,
                fontSize: "16px",
                fontWeight: 600,
                lineHeight: "20px",
                color: "#ffffff",
                textDecoration: "none",
                borderRadius: "6px",
              }}
            >
              {props.label}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function EmailParagraph(props: { readonly children: ReactNode }): JSX.Element {
  return (
    <p style={{ margin: "0 0 16px 0", fontSize: "16px", lineHeight: "24px", color: TEXT_COLOR }}>
      {props.children}
    </p>
  );
}

/**
 * Visible plain-text copy of an action URL, for clients that strip the button.
 * Rendered as a link too so the URL stays clickable where it is not stripped.
 */
export function EmailFallbackUrl(props: { readonly url: string }): JSX.Element {
  return (
    <p style={{ margin: "0 0 16px 0", fontSize: "13px", lineHeight: "20px", color: MUTED_COLOR }}>
      {"If the button does not work, paste this into your browser: "}
      <a href={props.url} style={{ color: MUTED_COLOR, wordBreak: "break-all" }}>
        {props.url}
      </a>
    </p>
  );
}
