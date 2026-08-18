"use client";

import { useCallback, useEffect, useState } from "react";

import { loadMentionEmailPreference, setMentionEmailPreference } from "@/lib/shell/requests";

/**
 * The unsubscribe control the mention email's footer promises.
 *
 * Part 61 shipped the suppression backend (a sentinel `email_deliveries` row)
 * and a `POST` to set it, but no read path and no UI — so `mention.tsx` linked
 * members to a settings page with nothing on it. This is the control; the `GET`
 * added alongside it is what lets the toggle show its own state.
 *
 * Deliberately NOT gated on `canManage`. Every other block on this page is a
 * workspace-admin setting; this one is the caller's OWN mail preference, and a
 * member who cannot rename the workspace must still be able to stop being
 * emailed. The API resolves the address from the authenticated id, so a member
 * can only ever change their own.
 *
 * ponytail: local state, no TanStack Query. There is exactly one reader, no
 * cache to share and nothing to invalidate. Upgrade path: move onto the query
 * client when Part 72 adds a real preferences surface with several controls.
 */
export function MentionEmailPreference({ workspaceId }: { readonly workspaceId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const result = await loadMentionEmailPreference(workspaceId);
    if (result.ok) {
      setEnabled(result.data.mentionEmail);
      return;
    }
    setFailed(true);
    setStatus(
      result.kind === "forbidden"
        ? "You do not have access to email preferences for this workspace."
        : "Email preferences could not be loaded. Nothing was changed.",
    );
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(next: boolean): Promise<void> {
    setSaving(true);
    setStatus("");
    const result = await setMentionEmailPreference(workspaceId, next);
    setSaving(false);
    if (!result.ok) {
      // Never leave the checkbox showing a value the server did not accept.
      setStatus("That change could not be saved. Your preference is unchanged.");
      return;
    }
    setEnabled(result.data.mentionEmail);
    setStatus(
      result.data.mentionEmail
        ? "Mention emails are on for this workspace."
        : "Mention emails are off for this workspace. You will still see mentions in your notifications.",
    );
  }

  return (
    <section aria-labelledby="mention-email-heading" className="space-y-3 rounded-md border p-4">
      <h2 id="mention-email-heading" className="text-lg font-semibold">
        Your email preferences
      </h2>
      <p className="text-sm text-muted-foreground">
        These apply to you alone in this workspace, not to other members.
      </p>

      {failed ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{status}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
          >
            Try again
          </button>
        </div>
      ) : enabled === null ? (
        <p className="text-sm text-muted-foreground">Loading your email preferences…</p>
      ) : (
        <div className="flex min-h-11 items-center gap-3">
          <input
            id="mention-email-preference"
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(event) => void toggle(event.target.checked)}
            className="size-4"
          />
          <label htmlFor="mention-email-preference" className="text-sm">
            Email me when someone mentions me in a note
          </label>
        </div>
      )}

      {/* One live region, and only for text that has no box of its own. */}
      <p aria-live="polite" aria-atomic="true" className="min-h-5 text-sm text-muted-foreground">
        {failed ? "" : status}
      </p>
    </section>
  );
}
