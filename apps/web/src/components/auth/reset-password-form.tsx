"use client";

import { resetPasswordSchema } from "@notted/shared-validators";
import Link from "next/link";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { fieldErrorsFromZod, firstFieldError, type FieldErrors } from "@/lib/auth/form-errors";
import { resetPassword } from "@/lib/auth/requests";

export function ResetPasswordForm({ token }: { readonly token: string }) {
  const summaryRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [complete, setComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function showError(message: string): void {
    setFormError(message);
    requestAnimationFrame(() => summaryRef.current?.focus());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setErrors({});
    setFormError(undefined);
    const data = new FormData(form);
    const newPassword = data.get("newPassword");
    if (newPassword !== data.get("passwordConfirmation")) {
      setErrors({ passwordConfirmation: "Passwords must match" });
      showError("Passwords must match");
      return;
    }
    const parsed = resetPasswordSchema.safeParse({ token, newPassword });
    if (!parsed.success) {
      const nextErrors = fieldErrorsFromZod(parsed.error);
      setErrors(nextErrors);
      showError(firstFieldError(nextErrors) ?? "Check the form and try again.");
      return;
    }

    setSubmitting(true);
    const result = await resetPassword(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      showError(
        result.kind === "network"
          ? "Password reset is temporarily unreachable. Check your connection and retry."
          : "This reset link is invalid or expired. Request a new link and try again.",
      );
      return;
    }
    setComplete(true);
    form.reset();
  }

  if (complete) {
    return (
      <div className="space-y-4">
        <FormStatus>
          Your password has been reset. All existing sessions were signed out.
        </FormStatus>
        <Button asChild className="w-full">
          <Link href="/login">Sign in with the new password</Link>
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)} noValidate>
      {formError === undefined ? null : <ErrorSummary ref={summaryRef} message={formError} />}
      <FormField
        id="reset-password"
        name="newPassword"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint="Use 8–128 characters with upper and lowercase letters, a number, and a symbol."
        error={errors.newPassword}
        disabled={submitting}
        required
      />
      <FormField
        id="reset-password-confirmation"
        name="passwordConfirmation"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        error={errors.passwordConfirmation}
        disabled={submitting}
        required
      />
      {submitting ? <FormStatus>Resetting your password…</FormStatus> : null}
      <Button className="w-full" type="submit" disabled={submitting}>
        {submitting ? "Resetting password…" : "Reset password"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/forgot-password" className="font-medium text-primary hover:underline">
          Request a new reset link
        </Link>
      </p>
    </form>
  );
}
