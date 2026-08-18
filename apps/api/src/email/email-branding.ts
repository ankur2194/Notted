// Part 61 — pure branding resolution for rendered email.
//
// Templates must never reach for the database, so branding is resolved once by
// the caller (handler) and handed to `EmailRendererService.render` as data.
// `workspaces.settings` is untyped `jsonb`: it is parsed defensively here and
// ANY miss (wrong container type, wrong member type, malformed colour) falls
// back to the platform default rather than throwing inside a queue handler.

import { z } from "zod";

/** Platform display name. Also the fallback workspace name for system email. */
export const PLATFORM_BRANDING_NAME = "Notted";

/** Platform accent, used whenever a workspace has not chosen one. */
export const DEFAULT_ACCENT_COLOR = "#2563eb";

/**
 * Everything a template is allowed to know about who the mail is "from".
 * Deliberately flat and serialisable — no Drizzle rows leak into JSX.
 */
export interface EmailBranding {
  /** Workspace name, or the platform name for workspace-less email. */
  readonly name: string;
  /** Absolute http(s) logo URL, or `null` to render the wordmark instead. */
  readonly logoUrl: string | null;
  /** `#rrggbb`. Already validated, so templates can inline it as a style. */
  readonly accentColor: string;
  /** Origin of the web app, for footer and preference links. */
  readonly appUrl: string;
}

/** Branding-relevant workspace columns. Matches `workspaces` exactly. */
export interface BrandingWorkspaceRow {
  readonly name: string;
  readonly logoUrl: string | null;
  readonly settings: unknown;
}

/**
 * Same accent shape `WorkspacesService` already persists (`#rrggbb`). A
 * non-object `settings` (string, array, number, null) fails this parse and the
 * caller falls back — which is the whole point of parsing untyped jsonb.
 */
const brandingSettingsSchema = z
  .object({
    accentColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/iu)
      .optional(),
  })
  .catchall(z.unknown());

function safeAccentColor(settings: unknown): string {
  // `z.object` accepts arrays in some versions; reject them explicitly so an
  // array-shaped `settings` can never contribute a colour.
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return DEFAULT_ACCENT_COLOR;
  }
  const parsed = brandingSettingsSchema.safeParse(settings);
  if (!parsed.success) return DEFAULT_ACCENT_COLOR;
  return parsed.data.accentColor ?? DEFAULT_ACCENT_COLOR;
}

/**
 * Only absolute http(s) logos survive. A `javascript:`/`data:` value stored by
 * an earlier bug must never reach an `<img src>` in a mailbox.
 */
function safeLogoUrl(logoUrl: string | null): string | null {
  if (logoUrl === null || logoUrl.trim() === "") return null;
  try {
    const parsed = new URL(logoUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Pure. `workspace === null` yields platform branding (system email). */
export function resolveBranding(
  workspace: BrandingWorkspaceRow | null,
  appConfig: { readonly appUrl: URL },
): EmailBranding {
  const appUrl = appConfig.appUrl.origin;
  if (workspace === null) {
    return Object.freeze({
      name: PLATFORM_BRANDING_NAME,
      logoUrl: null,
      accentColor: DEFAULT_ACCENT_COLOR,
      appUrl,
    });
  }
  const name = workspace.name.trim();
  return Object.freeze({
    name: name === "" ? PLATFORM_BRANDING_NAME : name,
    logoUrl: safeLogoUrl(workspace.logoUrl),
    accentColor: safeAccentColor(workspace.settings),
    appUrl,
  });
}
