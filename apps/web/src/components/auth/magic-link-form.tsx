"use client";

import { requestMagicLinkSchema } from "@notted/shared-validators";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { authResultUrl } from "@/lib/auth/callbacks";
import { fieldErrorsFromZod, firstFieldError, type FieldErrors } from "@/lib/auth/form-errors";
import { requestMagicLink } from "@/lib/auth/requests";

export function MagicLinkForm({ redirectTo }: { readonly redirectTo: string }) {
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
    const data = new FormData(form);
    const parsed = requestMagicLinkSchema.safeParse({
      email: data.get("email"),
      callbackURL: authResultUrl("/magic-link", redirectTo, "success"),
      newUserCallbackURL: authResultUrl("/magic-link", redirectTo, "success"),
      errorCallbackURL: authResultUrl("/magic-link", redirectTo, "error"),
    });
    if (!parsed.success) {
      const nextErrors = fieldErrorsFromZod(parsed.error);
      setErrors(nextErrors);
      setFormError(firstFieldError(nextErrors));
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setSubmitting(true);
    const result = await requestMagicLink(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFormError("We could not send the link right now. Check your connection and try again.");
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setStatus("If an account can use this address, a sign-in link is on its way.");
    form.reset();
  }

  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">Email me a sign-in link</summary>
      <form className="mt-4 space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        {formError === undefined ? null : <ErrorSummary ref={summaryRef} message={formError} />}
        <FormField
          id="magic-email"
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
          <FormStatus>Sending a sign-in link…</FormStatus>
        ) : status === undefined ? null : (
          <FormStatus>{status}</FormStatus>
        )}
        <Button className="w-full" variant="outline" type="submit" disabled={submitting}>
          {submitting ? "Sending link…" : "Send sign-in link"}
        </Button>
      </form>
    </details>
  );
}
