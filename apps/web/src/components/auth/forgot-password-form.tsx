"use client";

import { requestPasswordResetSchema } from "@notted/shared-validators";
import Link from "next/link";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { fieldErrorsFromZod, firstFieldError, type FieldErrors } from "@/lib/auth/form-errors";
import { requestPasswordReset } from "@/lib/auth/requests";

export function ForgotPasswordForm() {
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
    const parsed = requestPasswordResetSchema.safeParse({
      email: new FormData(form).get("email"),
    });
    if (!parsed.success) {
      const nextErrors = fieldErrorsFromZod(parsed.error);
      setErrors(nextErrors);
      setFormError(firstFieldError(nextErrors));
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setSubmitting(true);
    const result = await requestPasswordReset(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFormError("We could not process the request right now. Check your connection and retry.");
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setStatus("If an account exists for this email, password reset instructions are on the way.");
    form.reset();
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)} noValidate>
      {formError === undefined ? null : <ErrorSummary ref={summaryRef} message={formError} />}
      <FormField
        id="forgot-email"
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
        <FormStatus>Requesting password reset instructions…</FormStatus>
      ) : status === undefined ? null : (
        <FormStatus>{status}</FormStatus>
      )}
      <Button className="w-full" type="submit" disabled={submitting}>
        {submitting ? "Requesting reset…" : "Request password reset"}
      </Button>
      <p className="text-center text-sm">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Return to sign in
        </Link>
      </p>
    </form>
  );
}
