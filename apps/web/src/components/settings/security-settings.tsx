"use client";

import { passkeyNameSchema, totpCodeSchema } from "@notted/shared-validators";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

import type { AuthCapabilities, AuthSecurityOverview } from "@notted/shared-types";

import { ReauthenticationDialog } from "@/components/auth/reauthentication-dialog";
import { Button } from "@/components/ui/button";
import { FormField, FormStatus } from "@/components/ui/form-controls";
import {
  addPasskey,
  deletePasskey,
  disableTwoFactor,
  enableTwoFactor,
  regenerateRecoveryCodes,
  verifyTotp,
} from "@/lib/auth/requests";
import {
  loadSecurityOverview,
  revokeOtherSessions,
  revokeRemoteSession,
} from "@/lib/auth/security-requests";

type PendingAction =
  | { readonly kind: "enable-two-factor" }
  | { readonly kind: "disable-two-factor" }
  | { readonly kind: "regenerate-recovery" }
  | { readonly kind: "add-passkey"; readonly name: string }
  | { readonly kind: "delete-passkey"; readonly id: string }
  | { readonly kind: "revoke-session"; readonly id: string }
  | { readonly kind: "revoke-others" };

interface EnrollmentState {
  readonly totpURI: string;
  readonly recoveryCodes: readonly string[];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function SecuritySettings({ capabilities }: { readonly capabilities: AuthCapabilities }) {
  const [overview, setOverview] = useState<AuthSecurityOverview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [passkeyName, setPasskeyName] = useState("");
  const [enrollment, setEnrollment] = useState<EnrollmentState>();
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const [operationBusy, setOperationBusy] = useState(false);
  const [passkeySupport, setPasskeySupport] = useState<
    "checking" | "ready" | "insecure" | "unsupported"
  >("checking");

  const refresh = useCallback(async () => {
    setError(undefined);
    const next = await loadSecurityOverview();
    setLoading(false);
    if (next === null) {
      setError("Security settings could not be loaded. No changes were made.");
      return;
    }
    setOverview(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.isSecureContext) {
      setPasskeySupport("insecure");
    } else if (!("PublicKeyCredential" in window)) {
      setPasskeySupport("unsupported");
    } else {
      setPasskeySupport("ready");
    }
  }, []);

  async function afterConfirmation(password: string | undefined): Promise<boolean> {
    if (pending === undefined) return false;
    setOperationBusy(true);
    setError(undefined);
    let succeeded = false;

    if (pending.kind === "enable-two-factor") {
      const result = await enableTwoFactor(password);
      if (result.ok) {
        setEnrollment({ totpURI: result.totpURI, recoveryCodes: result.recoveryCodes });
        succeeded = true;
      }
    } else if (pending.kind === "disable-two-factor") {
      succeeded = (await disableTwoFactor(password)).ok;
      if (succeeded) {
        setEnrollment(undefined);
        setRecoveryCodes(undefined);
        setTotpCode("");
      }
    } else if (pending.kind === "regenerate-recovery") {
      const result = await regenerateRecoveryCodes(password);
      if (result.ok) {
        setRecoveryCodes(result.recoveryCodes);
        succeeded = true;
      }
    } else if (pending.kind === "add-passkey") {
      succeeded = (await addPasskey(pending.name)).ok;
      if (succeeded) setPasskeyName("");
    } else if (pending.kind === "delete-passkey") {
      succeeded = (await deletePasskey(pending.id)).ok;
    } else if (pending.kind === "revoke-session") {
      succeeded = (await revokeRemoteSession(pending.id)).ok;
    } else {
      succeeded = (await revokeOtherSessions()).ok;
    }

    setOperationBusy(false);
    if (!succeeded) {
      setError("The security change could not be completed. Confirm your identity and try again.");
      return false;
    }
    setPending(undefined);
    if (pending.kind !== "enable-two-factor" && pending.kind !== "regenerate-recovery") {
      await refresh();
    }
    return true;
  }

  async function confirmEnrollment(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = totpCodeSchema.safeParse(totpCode);
    if (!parsed.success) {
      setError("Enter the current six-digit authenticator code.");
      return;
    }
    setOperationBusy(true);
    const result = await verifyTotp(parsed.data);
    setOperationBusy(false);
    if (!result.ok || enrollment === undefined) {
      setError("The authenticator code could not be confirmed. Check the time and try again.");
      return;
    }
    setRecoveryCodes(enrollment.recoveryCodes);
    setEnrollment(undefined);
    setTotpCode("");
    await refresh();
  }

  function requestPasskeyRegistration(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (passkeySupport !== "ready") {
      setError(
        passkeySupport === "insecure"
          ? "Passkeys require a secure HTTPS context. Localhost is allowed for development."
          : "This browser does not support passkeys.",
      );
      return;
    }
    const parsed = passkeyNameSchema.safeParse(passkeyName);
    if (!parsed.success) {
      setError("Give the passkey a name between 1 and 64 characters.");
      return;
    }
    setPending({ kind: "add-passkey", name: parsed.data });
  }

  if (loading) {
    return <FormStatus>Loading security settings…</FormStatus>;
  }

  if (overview === undefined) {
    return (
      <div className="space-y-4" role="alert">
        <p>{error ?? "Security settings are unavailable."}</p>
        <Button type="button" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error === undefined ? null : (
        <div
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      <section
        className="space-y-4 rounded-xl border border-border p-5"
        aria-labelledby="two-factor-title"
      >
        <div>
          <h2 id="two-factor-title" className="text-xl font-semibold">
            Two-factor authentication
          </h2>
          <p className="text-sm text-muted-foreground">
            {overview.twoFactorEnabled
              ? "An authenticator code is required after password sign-in."
              : "Add an authenticator app and one-time recovery codes."}
          </p>
        </div>
        {enrollment === undefined ? (
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={() =>
                setPending({
                  kind: overview.twoFactorEnabled ? "disable-two-factor" : "enable-two-factor",
                })
              }
            >
              {overview.twoFactorEnabled
                ? "Disable two-factor authentication"
                : "Enable two-factor authentication"}
            </Button>
            {overview.twoFactorEnabled ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setPending({ kind: "regenerate-recovery" })}
              >
                Regenerate recovery codes
              </Button>
            ) : null}
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => void confirmEnrollment(event)}>
            <p className="font-medium">Scan this QR code, then enter the current code.</p>
            <div className="w-fit rounded-lg bg-white p-4">
              <QRCodeSVG
                value={enrollment.totpURI}
                size={192}
                title="Authenticator setup QR code"
                role="img"
                aria-label="Authenticator setup QR code"
              />
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Use the setup URI instead
              </summary>
              <code className="mt-2 block break-all rounded bg-muted p-3 text-xs">
                {enrollment.totpURI}
              </code>
            </details>
            <FormField
              id="enrollment-code"
              name="code"
              label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(event) => setTotpCode(event.currentTarget.value)}
              disabled={operationBusy}
              required
            />
            <div className="flex gap-3">
              <Button type="submit" disabled={operationBusy}>
                Confirm authenticator
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={operationBusy}
                onClick={() => {
                  setEnrollment(undefined);
                  setTotpCode("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {recoveryCodes === undefined ? null : (
          <div className="space-y-3 rounded-md border border-border bg-muted/40 p-4" role="status">
            <h3 className="font-semibold">Save these recovery codes now</h3>
            <p className="text-sm">They are shown once. Each code can be used only one time.</p>
            <ul className="grid gap-2 font-mono text-sm sm:grid-cols-2">
              {recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <Button type="button" onClick={() => setRecoveryCodes(undefined)}>
              I saved these codes
            </Button>
          </div>
        )}
      </section>

      <section
        className="space-y-4 rounded-xl border border-border p-5"
        aria-labelledby="passkeys-title"
      >
        <div>
          <h2 id="passkeys-title" className="text-xl font-semibold">
            Passkeys
          </h2>
          <p className="text-sm text-muted-foreground">
            Passkeys require a supported browser and a secure HTTPS context. Localhost is allowed in
            development.
          </p>
          {passkeySupport === "insecure" ? (
            <p className="text-sm text-destructive" role="status">
              Passkey controls are unavailable because this page is not in a secure context.
            </p>
          ) : passkeySupport === "unsupported" ? (
            <p className="text-sm text-muted-foreground" role="status">
              This browser does not support passkeys. Use a current browser or another sign-in
              method.
            </p>
          ) : passkeySupport === "checking" ? (
            <p className="text-sm text-muted-foreground" role="status">
              Checking passkey support…
            </p>
          ) : null}
        </div>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={requestPasskeyRegistration}
        >
          <div className="flex-1">
            <FormField
              id="passkey-name"
              name="name"
              label="New passkey name"
              value={passkeyName}
              onChange={(event) => setPasskeyName(event.currentTarget.value)}
              placeholder="Work laptop"
              disabled={!capabilities.passkeyEnabled || operationBusy || passkeySupport !== "ready"}
              required
            />
          </div>
          <Button
            type="submit"
            disabled={!capabilities.passkeyEnabled || operationBusy || passkeySupport !== "ready"}
          >
            Register passkey
          </Button>
        </form>
        {overview.passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passkeys are registered.</p>
        ) : (
          <ul className="divide-y divide-border">
            {overview.passkeys.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {item.deviceType} · {item.backedUp ? "synced" : "device-bound"} · Added{" "}
                    {formatDate(item.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPending({ kind: "delete-passkey", id: item.id })}
                >
                  Remove passkey
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="space-y-4 rounded-xl border border-border p-5"
        aria-labelledby="sessions-title"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="sessions-title" className="text-xl font-semibold">
              Active sessions
            </h2>
            <p className="text-sm text-muted-foreground">
              Remembered sessions last {Math.round(capabilities.rememberedSessionSeconds / 86_400)}{" "}
              days; other sessions last one day.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={overview.sessions.filter((item) => !item.current).length === 0}
            onClick={() => setPending({ kind: "revoke-others" })}
          >
            Revoke other sessions
          </Button>
        </div>
        {overview.sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions were found.</p>
        ) : (
          <ul className="divide-y divide-border">
            {overview.sessions.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <p className="font-medium">
                    {item.device}{" "}
                    {item.current ? <span className="text-primary">(current)</span> : null}
                  </p>
                  <dl className="mt-1 grid gap-x-4 text-sm text-muted-foreground sm:grid-cols-3">
                    <div>
                      <dt>Created</dt>
                      <dd>{formatDate(item.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatDate(item.updatedAt)}</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{formatDate(item.expiresAt)}</dd>
                    </div>
                  </dl>
                </div>
                {item.current ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPending({ kind: "revoke-session", id: item.id })}
                  >
                    Revoke session
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReauthenticationDialog
        open={pending !== undefined}
        title="Confirm this security change"
        onCancel={() => setPending(undefined)}
        onConfirmed={afterConfirmation}
      />
    </div>
  );
}
