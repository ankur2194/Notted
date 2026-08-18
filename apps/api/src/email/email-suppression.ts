// Part 61 — "should this template be sent to this address in this workspace?".
//
// Only OPTIONAL email is suppressible. Transactional mail a user asked for
// (verification, magic link, password reset, an invitation they were sent) is
// never gated: silently dropping it would lock people out of their accounts.

import { and, eq, isNull, sql } from "drizzle-orm";

import { emailDeliveries } from "../database/schema";

import type { EmailTemplateKey } from "./email-templates";
import type { DatabaseTransaction } from "../database/database.service";

/** Templates a recipient may switch off. Everything else is mandatory. */
export const SUPPRESSIBLE_TEMPLATE_KEYS: ReadonlySet<EmailTemplateKey> = new Set(["mention"]);

/** `email_deliveries.related_entity_type` of a suppression sentinel row. */
export const UNSUBSCRIBE_RELATED_ENTITY_TYPE = "unsubscribe";

/** Addresses are compared case-insensitively; store and query the same form. */
export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

/**
 * True when the recipient has switched this template off for this workspace.
 *
 * Workspace-scoped by design: the preference toggle lives on a workspace route
 * (`POST /api/v1/workspaces/:workspaceId/notifications/email-preference`), so a
 * global check would let one tenant mute another tenant's mail — and ADR 0009
 * requires every tenant-scoped query to prove its scope.
 */
export async function isSuppressed(
  tx: DatabaseTransaction,
  recipient: string,
  templateKey: EmailTemplateKey,
  workspaceId: string | null,
): Promise<boolean> {
  // Mandatory templates short-circuit before any SQL. `welcome` in particular
  // has no workspace, so there is nothing coherent to scope a lookup by.
  if (!SUPPRESSIBLE_TEMPLATE_KEYS.has(templateKey)) return false;

  // ponytail: suppression is a sentinel email_deliveries row, not a preference table. Upgrade path: an email_preferences table when Part 72 adds real per-user settings.
  const normalized = normalizeRecipient(recipient);
  const [row] = await tx
    .select({ id: emailDeliveries.id })
    .from(emailDeliveries)
    .where(
      and(
        // Normalise BOTH sides: rows written before `normalizeRecipient`
        // existed may still carry mixed case.
        // ponytail: `lower(recipient)` does NOT use `email_deliveries_recipient_idx` — that index is a plain btree on the raw column, so wrapping it in `lower()` makes this a sequential scan. Acceptable while the table is small and this runs once per outbound email. Upgrade path: a `lower(recipient)` expression index when `email_deliveries` grows enough to measure.
        sql`lower(${emailDeliveries.recipient}) = ${normalized}`,
        eq(emailDeliveries.templateKey, templateKey),
        eq(emailDeliveries.status, "suppressed"),
        eq(emailDeliveries.relatedEntityType, UNSUBSCRIBE_RELATED_ENTITY_TYPE),
        workspaceId === null
          ? isNull(emailDeliveries.workspaceId)
          : eq(emailDeliveries.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
