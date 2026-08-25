"use client";

import { customDomainHostnameSchema } from "@notted/shared-validators";
import { useCallback, useEffect, useState } from "react";

import type { ApiRequestFailureKind, ApiRequestResult } from "@/lib/api/request-json";
import type {
  WorkspaceDomain,
  WorkspaceDomainError,
  WorkspaceDomainRecord,
  WorkspaceDomainResult,
  WorkspaceDomainStatus,
} from "@notted/shared-types";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField } from "@/components/ui/form-controls";
import {
  loadWorkspaceDomain,
  removeWorkspaceDomain,
  setWorkspaceDomain,
  verifyWorkspaceDomain,
} from "@/lib/workspaces/domain-requests";

/**
 * Part 73 — the workspace's custom hostname.
 *
 * Its OWN section rather than a field in Identity: claiming a hostname is a
 * four-step conversation (claim, publish DNS, verify, re-check) against three
 * routes of its own, and none of it belongs in a form whose Save button must
 * either succeed or fail as one PATCH.
 *
 * ponytail: local state, no query client — the same call `ApiKeys` makes. There
 * is one reader and nothing to invalidate beyond this component's own load.
 * Move it onto the query client when a second surface needs the same record.
 */

/**
 * A 403 and a 404 arrive as the same `kind`, and on the initial read a 404 also
 * means custom domains are switched off for this deployment. Rather than guess,
 * one message covers both truthfully — the alternative is telling an admin they
 * lack a permission they actually have.
 */
const UNAVAILABLE_MESSAGE =
  "Custom domains are not enabled on this deployment, or you do not have access to them. Ask an administrator if you expected this to be available.";

/**
 * Exhaustive over `WorkspaceDomainError` on purpose: the record is typed by the
 * union, so a new failure code added to the shared contract is a type error here
 * rather than a blank space where the remedy should be.
 */
const ERROR_REMEDIES: Record<WorkspaceDomainError, string> = {
  txt_missing:
    "The TXT record was not found. Add it at your DNS provider exactly as shown below, then check again — new records can take up to an hour to publish.",
  txt_mismatch:
    "A TXT record exists but its value does not match. Replace it with the value shown below, removing any older Notted verification record.",
  cname_mismatch:
    "The CNAME record does not point at Notted. Point it at the target shown below, and remove any A or AAAA record on the same name.",
  dns_failure:
    "The domain's nameservers could not be reached. Confirm the domain is registered and its nameservers are responding, then check again.",
};

const STATUS_LABELS: Record<WorkspaceDomainStatus, string> = {
  pending: "Pending verification",
  verified: "Verified",
  error: "Verification failed",
};

function failureMessage(kind: ApiRequestFailureKind, code: string | undefined): string {
  if (code === "DOMAIN_TAKEN") {
    return "That domain is already claimed by another workspace. Choose a different hostname.";
  }
  if (code === "DOMAIN_RESERVED") {
    return "That domain is reserved by this platform and cannot be claimed.";
  }
  switch (kind) {
    case "forbidden-or-not-found":
      return UNAVAILABLE_MESSAGE;
    case "invalid":
      return "That domain was rejected. Enter a public domain name such as notes.example.com.";
    case "conflict":
    case "version-conflict":
      return "That domain is already claimed. Choose a different hostname.";
    default:
      return "Custom domains are unavailable right now. Nothing was changed.";
  }
}

function DnsRecord({
  record,
  disabled,
  onCopy,
}: {
  readonly record: WorkspaceDomainRecord;
  readonly disabled: boolean;
  readonly onCopy: (value: string, label: string) => void;
}) {
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <dt className="font-medium">
        {record.type} record — {record.name}
      </dt>
      <dd className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
          {record.value}
        </code>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          aria-label={`Copy ${record.type} record value`}
          onClick={() => onCopy(record.value, record.type)}
        >
          Copy
        </Button>
      </dd>
    </div>
  );
}

export function CustomDomainSettings({ workspaceId }: { readonly workspaceId: string }) {
  const [domain, setDomain] = useState<WorkspaceDomain | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailure, setLoadFailure] = useState<ApiRequestFailureKind | null>(null);
  const [hostname, setHostname] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadFailure(null);
    const result = await loadWorkspaceDomain(workspaceId);
    setLoaded(true);
    if (result.ok) {
      setDomain(result.data.domain);
      return;
    }
    setDomain(null);
    setLoadFailure(result.kind);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation answers the same shape, so they share one landing. */
  async function run(
    action: () => Promise<ApiRequestResult<WorkspaceDomainResult>>,
    success: (next: WorkspaceDomain | null) => string,
  ): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    setStatus("Working…");
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setStatus("");
      setActionError(failureMessage(result.kind, result.code));
      return false;
    }
    setDomain(result.data.domain);
    setStatus(success(result.data.domain));
    return true;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Client-side only so the reader is told before a round trip; the server
    // re-validates the same schema and stays the authority.
    const parsed = customDomainHostnameSchema.safeParse(hostname);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Enter a valid domain name.");
      return;
    }
    setFieldError(null);
    const claimed = await run(
      () => setWorkspaceDomain(workspaceId, parsed.data),
      (next) =>
        next === null
          ? "The domain was not claimed."
          : `${next.hostname} was claimed. Publish the two DNS records below, then check again.`,
    );
    // Kept on failure: a rejected hostname is one the user is about to edit,
    // and clearing it would make them retype what the server just complained
    // about.
    if (claimed) setHostname("");
  }

  async function copy(value: string, label: string): Promise<void> {
    // Guarded: the Clipboard API is absent on insecure origins and in older
    // browsers, and an unguarded call there throws into an empty catch.
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setStatus(`The ${label} value could not be copied. Select it and copy it manually.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`${label} record value copied to the clipboard.`);
    } catch {
      setStatus(`The ${label} value could not be copied. Select it and copy it manually.`);
    }
  }

  return (
    <section
      className="space-y-4 rounded-xl border border-border p-5"
      aria-labelledby="workspace-domain-title"
      aria-busy={busy || !loaded}
    >
      <div>
        <h2 id="workspace-domain-title" className="text-xl font-semibold">
          Custom domain
        </h2>
        <p className="text-sm text-muted-foreground">
          Serve this workspace on a hostname you own. Notted verifies ownership through DNS before
          the hostname becomes active.
        </p>
      </div>

      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading the custom domain…</p>
      ) : loadFailure !== null ? (
        <div className="space-y-3 text-sm">
          {loadFailure === "forbidden-or-not-found" ? (
            <p role="note" className="rounded-md border border-border bg-muted/40 p-3">
              {UNAVAILABLE_MESSAGE}
            </p>
          ) : (
            <>
              <p role="alert">The custom domain could not be loaded. Nothing was changed.</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void load()}
              >
                Try again
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          {actionError !== null ? <ErrorSummary message={actionError} /> : null}

          {domain === null ? (
            <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
              <FormField
                id="settings-custom-domain"
                name="hostname"
                type="text"
                // NOT "Custom domain": the section is already named that
                // (`aria-labelledby` -> the h2), and two elements sharing one
                // accessible name is ambiguous to a screen-reader user reading
                // the section by name, not only to a test query.
                label="Domain name"
                value={hostname}
                onChange={(event) => {
                  setHostname(event.currentTarget.value);
                  setFieldError(null);
                }}
                disabled={busy}
                placeholder="notes.example.com"
                maxLength={253}
                autoComplete="off"
                spellCheck={false}
                className="min-h-11"
                error={fieldError ?? undefined}
                hint="A subdomain you control, without a protocol, path, or port."
              />
              <Button type="submit" className="min-h-11" disabled={busy}>
                {busy ? "Adding…" : "Add domain"}
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                <span className="font-medium">{domain.hostname}</span>{" "}
                {/* The status is spelled out in text, never carried by colour alone. */}
                <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                  {STATUS_LABELS[domain.status]}
                </span>
              </p>

              {domain.lastError !== null ? (
                <p className="text-sm text-destructive">{ERROR_REMEDIES[domain.lastError]}</p>
              ) : null}

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">DNS records to publish</h3>
                <dl className="space-y-2">
                  <DnsRecord
                    record={domain.verificationRecord}
                    disabled={busy}
                    onCopy={(value, label) => void copy(value, label)}
                  />
                  <DnsRecord
                    record={domain.cnameRecord}
                    disabled={busy}
                    onCopy={(value, label) => void copy(value, label)}
                  />
                </dl>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => verifyWorkspaceDomain(workspaceId),
                      (next) =>
                        next === null
                          ? "The domain is no longer claimed."
                          : next.status === "verified"
                            ? `${next.hostname} is verified and active.`
                            : `${next.hostname} is not verified yet.`,
                    )
                  }
                >
                  {busy ? "Checking…" : "Check again"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => removeWorkspaceDomain(workspaceId),
                      () =>
                        "The custom domain was removed. The workspace is served on the primary host only.",
                    )
                  }
                >
                  Remove domain
                </Button>
              </div>
            </div>
          )}

          {/*
            A documented Part 73 limitation, and one a user will otherwise meet
            as a bug: sign-in runs on the primary host, and the session cookie a
            custom host holds is host-only, so the two hosts hold two sessions.
          */}
          <p role="note" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            Signing in with OAuth, a magic link, or a passkey always happens on the primary
            application host. A session on your custom domain is separate from the one on the
            primary host, so signing out of one does not sign you out of the other.
          </p>
        </>
      )}

      <p
        aria-live="polite"
        role="status"
        aria-atomic="true"
        className="min-h-5 text-sm text-muted-foreground"
      >
        {actionError === null ? status : ""}
      </p>
    </section>
  );
}
