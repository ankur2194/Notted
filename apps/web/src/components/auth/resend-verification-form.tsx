"use client";

import { requestEmailVerificationSchema } from "@notted/shared-validators";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { authResultUrl } from "@/lib/auth/callbacks";
import { fieldErrorsFromZod, firstFieldError, type FieldErrors } from "@/lib/auth/form-errors";
import { resendVerification } from "@/lib/auth/requests";

export function ResendVerificationForm({ redirectTo }: { readonly redirectTo: string }) {
  const summaryRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setErrors({});
    setFormError(undefined);
    setStatus(undefined);
    const parsed = requestEmailVerificationSchema.safeParse({
      email: new FormData(form).get("email"),
      callbackURL: authResultUrl("/verify-email", redirectTo),
    });
    if (!parsed.success) {
      const nextErrors = fieldErrorsFromZod(parsed.error);
      setErrors(nextErrors);
      setFormError(firstFieldError(nextErrors));
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setSubmitting(true);
    const result = await resendVerification(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFormError("We could not send a verification email right now. Please retry.");
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setStatus("If this address needs verification, a new link is on the way.");
    form.reset();
  }

  return (
    <form
      className="space-y-4 border-t border-border pt-5"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h2 className="text-lg font-semibold">Need another verification link?</h2>
      {formError === undefined ? null : <ErrorSummary ref={summaryRef} message={formError} />}
      <FormField
        id="verification-email"
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        error={errors.email}
        disabled={submitting}
        required
      />
      {submitting ? (
        <FormStatus>Sending a verification email…</FormStatus>
      ) : status === undefined ? null : (
        <FormStatus>{status}</FormStatus>
      )}
      <Button className="w-full" variant="outline" type="submit" disabled={submitting}>
        {submitting ? "Sending…" : "Resend verification email"}
      </Button>
    </form>
  );
}
