"use client";

import { recoveryCodeSchema, totpCodeSchema } from "@notted/shared-validators";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { safeRedirectPath } from "@/lib/auth/redirects";
import { verifyRecoveryCode, verifyTotp } from "@/lib/auth/requests";

export function TwoFactorChallenge({ redirectTo }: { readonly redirectTo: string }) {
  const router = useRouter();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    const value = String(new FormData(event.currentTarget).get("code") ?? "");
    const parsed = (mode === "totp" ? totpCodeSchema : recoveryCodeSchema).safeParse(value);
    if (!parsed.success) {
      setError(mode === "totp" ? "Enter the six-digit code." : "Enter a valid recovery code.");
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setSubmitting(true);
    const result =
      mode === "totp" ? await verifyTotp(parsed.data) : await verifyRecoveryCode(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setError("That code could not be verified. Try again or use a recovery code.");
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    router.replace(safeRedirectPath(redirectTo));
    router.refresh();
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)} noValidate>
      {error === undefined ? null : <ErrorSummary ref={summaryRef} message={error} />}
      <FormField
        key={mode}
        id="two-factor-code"
        name="code"
        label={mode === "totp" ? "Authenticator code" : "Recovery code"}
        autoComplete={mode === "totp" ? "one-time-code" : "off"}
        inputMode={mode === "totp" ? "numeric" : "text"}
        hint={
          mode === "totp" ? "Enter the current six-digit code." : "Each recovery code works once."
        }
        disabled={submitting}
        required
      />
      {submitting ? <FormStatus>Verifying…</FormStatus> : null}
      <Button className="w-full" type="submit" disabled={submitting}>
        Verify and continue
      </Button>
      <Button
        className="w-full"
        type="button"
        variant="outline"
        disabled={submitting}
        onClick={() => {
          setMode((current) => (current === "totp" ? "recovery" : "totp"));
          setError(undefined);
        }}
      >
        {mode === "totp" ? "Use a recovery code" : "Use an authenticator code"}
      </Button>
    </form>
  );
}
