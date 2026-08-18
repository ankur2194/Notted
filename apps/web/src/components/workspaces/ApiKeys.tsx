"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { ApiKeyPage, ApiKeyScope } from "@notted/shared-types";
import type { FormEvent } from "react";

import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api-keys/requests";

/**
 * Part 65 — workspace API key management.
 *
 * Modelled on `MentionEmailPreference`: a small client component with local
 * state and no TanStack Query. There is one reader, no cache to share and
 * nothing to invalidate beyond re-running this component's own load.
 *
 * ponytail: local state, no query client. Upgrade path is the same as the
 * mention preference — move onto the query client when a second surface needs
 * the same list.
 *
 * The created secret lives in React state and nowhere else: no localStorage, no
 * URL, no clipboard until the reader asks. Dismissing the panel drops it, and a
 * refetch can never bring it back because the list response has no secret field
 * at all.
 */

const SCOPES: readonly { readonly value: ApiKeyScope; readonly label: string }[] = [
  { value: "read", label: "Read — list and fetch workspace content" },
  { value: "write", label: "Write — create and update workspace content" },
  { value: "admin", label: "Admin — manage workspace settings and members" },
];

const PERMISSION_MESSAGE = "You need to be a workspace admin to manage API keys.";

function failureMessage(kind: ApiRequestFailureKind): string {
  switch (kind) {
    case "forbidden-or-not-found":
      return PERMISSION_MESSAGE;
    case "invalid":
      return "That API key was rejected. Check the name and make sure the expiry date is in the future.";
    case "conflict":
    case "version-conflict":
      return "An API key with that name already exists in this workspace.";
    default:
      return "API keys are unavailable right now. Nothing was changed.";
  }
}

/** A date-only input is the end of that day; the server needs a full timestamp. */
function expiryTimestamp(date: string): string | undefined {
  if (date === "") return undefined;
  const at = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

function formatDate(value: string | null, absent: string): string {
  if (value === null) return absent;
  const at = Date.parse(value);
  return Number.isNaN(at) ? absent : new Date(at).toLocaleDateString();
}

export function ApiKeys({ workspaceId }: { readonly workspaceId: string }) {
  const [page, setPage] = useState<ApiKeyPage | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiRequestFailureKind | null>(null);
  const [status, setStatus] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly ApiKeyScope[]>(["read", "write"]);
  const [expiresOn, setExpiresOn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Same pattern as `WebhookSettings`. The control that opens the confirmation
  // is unmounted while it is open, so the node is remembered by id and
  // refocused once it has remounted; a completed revoke removes that control
  // for good, so focus lands on the section heading instead of the document.
  const revokeTriggers = useRef(new Map<string, HTMLButtonElement>());
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusId = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (confirmingId !== null) {
      confirmButtonRef.current?.focus();
      return;
    }
    const id = restoreFocusId.current;
    if (id === null) return;
    restoreFocusId.current = null;
    revokeTriggers.current.get(id)?.focus();
  }, [confirmingId]);

  const load = useCallback(async () => {
    setLoadFailure(null);
    const result = await listApiKeys(workspaceId, {
      page: 1,
      limit: 50,
      // Revoked keys stay listed: "this credential is dead" is exactly what an
      // admin comes here to confirm after revoking one.
      includeRevoked: true,
      sortBy: "createdAt",
      sortDirection: "desc",
    });
    if (result.ok) {
      setPage(result.data);
      return;
    }
    setPage(null);
    setLoadFailure(result.kind);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (name.trim() === "") {
      setStatus("Enter a name for the API key.");
      return;
    }
    if (scopes.length === 0) {
      setStatus("Select at least one scope.");
      return;
    }
    setSubmitting(true);
    setStatus("");
    setSecret(null);
    // Fresh per submission: a replayed key cannot return the secret again.
    const result = await createApiKey(
      workspaceId,
      { name: name.trim(), scopes: [...scopes], expiresAt: expiryTimestamp(expiresOn) },
      globalThis.crypto.randomUUID(),
    );
    setSubmitting(false);
    if (!result.ok) {
      setStatus(failureMessage(result.kind));
      return;
    }
    setSecret(result.data.secret);
    setName("");
    setExpiresOn("");
    setScopes(["read", "write"]);
    setStatus(`API key “${result.data.apiKey.name}” created. Copy the key now.`);
    await load();
  }

  async function revoke(apiKeyId: string, keyName: string): Promise<void> {
    setBusyId(apiKeyId);
    setStatus("");
    const result = await revokeApiKey(workspaceId, apiKeyId);
    setBusyId(null);
    if (!result.ok) {
      // The key is still revocable, so its trigger comes back: aim at it.
      restoreFocusId.current = apiKeyId;
      setConfirmingId(null);
      setStatus(failureMessage(result.kind));
      return;
    }
    setConfirmingId(null);
    setStatus(`API key “${keyName}” was revoked and can no longer be used.`);
    await load();
    // A revoked key shows no revoke control at all, so there is nothing to
    // restore focus to.
    revokeTriggers.current.delete(apiKeyId);
    headingRef.current?.focus();
  }

  async function copySecret(): Promise<void> {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret);
      setStatus("API key copied to the clipboard.");
    } catch {
      setStatus("The key could not be copied. Select it and copy it manually.");
    }
  }

  return (
    <section aria-labelledby="api-keys-heading" className="space-y-4 rounded-md border p-4">
      <h2 id="api-keys-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        API keys
      </h2>
      <p className="text-sm text-muted-foreground">
        Machine credentials for the public REST API. A key is shown once, when it is created.
      </p>

      {loadFailure !== null ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            {loadFailure === "forbidden-or-not-found"
              ? PERMISSION_MESSAGE
              : "API keys could not be loaded. Nothing was changed."}
          </p>
          {loadFailure === "forbidden-or-not-found" ? null : (
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
            >
              Try again
            </button>
          )}
        </div>
      ) : page === null ? (
        <p className="text-sm text-muted-foreground">Loading API keys…</p>
      ) : (
        <>
          {secret === null ? null : (
            <div
              aria-labelledby="api-key-secret-heading"
              role="group"
              className="space-y-2 rounded-md border-2 border-primary p-4"
            >
              <h3 id="api-key-secret-heading" className="text-sm font-semibold">
                Your new API key
              </h3>
              <code className="block break-all rounded bg-muted p-2 font-mono text-sm">
                {secret}
              </code>
              <p className="text-sm font-medium">This is the only time this key will be shown</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copySecret()}
                  className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
                >
                  Copy key
                </button>
                <button
                  type="button"
                  onClick={() => setSecret(null)}
                  className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
                >
                  I have saved it
                </button>
              </div>
            </div>
          )}

          <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="api-key-name" className="block text-sm font-medium">
                Name
              </label>
              <input
                id="api-key-name"
                type="text"
                required
                maxLength={100}
                value={name}
                disabled={submitting}
                onChange={(event) => setName(event.target.value)}
                className="min-h-11 w-full rounded-md border px-3 text-sm"
              />
            </div>

            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Scopes</legend>
              {SCOPES.map((scope) => (
                <div key={scope.value} className="flex min-h-11 items-center gap-3">
                  <input
                    id={`api-key-scope-${scope.value}`}
                    type="checkbox"
                    checked={scopes.includes(scope.value)}
                    disabled={submitting}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope.value]
                          : current.filter((value) => value !== scope.value),
                      )
                    }
                    className="size-4"
                  />
                  <label htmlFor={`api-key-scope-${scope.value}`} className="text-sm">
                    {scope.label}
                  </label>
                </div>
              ))}
            </fieldset>

            <div className="space-y-1">
              <label htmlFor="api-key-expires" className="block text-sm font-medium">
                Expires on (optional)
              </label>
              {/* Native date input: no picker library, and it is keyboard operable everywhere. */}
              <input
                id="api-key-expires"
                type="date"
                value={expiresOn}
                disabled={submitting}
                onChange={(event) => setExpiresOn(event.target.value)}
                className="min-h-11 rounded-md border px-3 text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {submitting ? "Creating…" : "Create API key"}
            </button>
          </form>

          {page.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <ul className="space-y-3">
              {page.items.map((item) => (
                <li key={item.id} className="space-y-1 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.name}</span>
                    <code className="rounded bg-muted px-1 font-mono text-xs">
                      {item.keyPrefix}
                    </code>
                    {item.isRevoked ? (
                      <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                        Revoked
                      </span>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground">Scopes: {item.scopes.join(", ")}</p>
                  <p className="text-muted-foreground">
                    Last used: {formatDate(item.lastUsedAt, "never")} · Expires:{" "}
                    {formatDate(item.expiresAt, "never")}
                  </p>
                  {item.isRevoked ? null : confirmingId === item.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>
                        Revoke “{item.name}”? Anything using it stops working immediately.
                      </span>
                      <button
                        type="button"
                        ref={confirmButtonRef}
                        disabled={busyId === item.id}
                        onClick={() => void revoke(item.id, item.name)}
                        className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                      >
                        Confirm revoke
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          restoreFocusId.current = item.id;
                          setConfirmingId(null);
                        }}
                        className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      ref={(node) => {
                        if (node === null) revokeTriggers.current.delete(item.id);
                        else revokeTriggers.current.set(item.id, node);
                      }}
                      onClick={() => setConfirmingId(item.id)}
                      className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium"
                    >
                      Revoke {item.name}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* One live region, and only for text that has no box of its own. */}
      <p aria-live="polite" aria-atomic="true" className="min-h-5 text-sm text-muted-foreground">
        {loadFailure === null ? status : ""}
      </p>
    </section>
  );
}
