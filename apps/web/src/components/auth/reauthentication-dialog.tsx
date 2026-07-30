"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, FormStatus } from "@/components/ui/form-controls";
import { reauthenticate, signInWithPasskey } from "@/lib/auth/requests";
import { loadPrincipal } from "@/lib/auth/security-requests";

interface ReauthenticationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onCancel: () => void;
  readonly onConfirmed: (password: string | undefined) => Promise<boolean>;
}

export function ReauthenticationDialog({
  open,
  title,
  onCancel,
  onConfirmed,
}: ReauthenticationDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    setPasskeySupported(window.isSecureContext && "PublicKeyCredential" in window);
  }, []);

  function close(): void {
    setPassword("");
    setError(undefined);
    onCancel();
  }

  async function confirmPassword(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password.length === 0) {
      setError("Enter your current password.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const credential = password;
    const reauthenticated = await reauthenticate(credential);
    if (!reauthenticated.ok || !(await onConfirmed(credential))) {
      setBusy(false);
      setPassword("");
      setError("Your identity could not be confirmed. Try again.");
      return;
    }
    setBusy(false);
    close();
  }

  async function confirmPasskey(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const before = await loadPrincipal();
    const result = await signInWithPasskey();
    const after = result.ok ? await loadPrincipal() : null;
    if (
      before === null ||
      after === null ||
      before.userId !== after.userId ||
      !(await onConfirmed(undefined))
    ) {
      setBusy(false);
      setError("The passkey could not confirm this account. Try your password instead.");
      return;
    }
    setBusy(false);
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? close() : undefined)}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            This security-sensitive change requires recent authentication. Your password is cleared
            as soon as this dialog closes or the request finishes.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} className="space-y-4" onSubmit={(event) => void confirmPassword(event)}>
          <FormField
            id="reauth-password"
            name="password"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            disabled={busy}
            required
          />
          {error === undefined ? null : (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {busy ? <FormStatus>Confirming identity…</FormStatus> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Confirm with password
            </Button>
          </DialogFooter>
        </form>
        {passkeySupported ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void confirmPasskey()}
            disabled={busy}
          >
            Confirm with a passkey
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
