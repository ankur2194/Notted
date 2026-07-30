"use client";

import { registerWithPasswordSchema } from "@notted/shared-validators";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { authResultUrl } from "@/lib/auth/callbacks";
import { fieldErrorsFromZod, firstFieldError, type FieldErrors } from "@/lib/auth/form-errors";
import { safeRedirectPath } from "@/lib/auth/redirects";
import { registerWithPassword } from "@/lib/auth/requests";

export function RegisterForm({ redirectTo }: { readonly redirectTo: string }) {
  const router = useRouter();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
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
    const password = data.get("password");
    const confirmation = data.get("passwordConfirmation");
    if (password !== confirmation) {
      setErrors({ passwordConfirmation: "Passwords must match" });
      showError("Passwords must match");
      return;
    }

    const parsed = registerWithPasswordSchema.safeParse({
      name: data.get("name"),
      email: data.get("email"),
      password,
      callbackURL: authResultUrl("/verify-email", redirectTo),
    });
    if (!parsed.success) {
      const nextErrors = fieldErrorsFromZod(parsed.error);
      setErrors(nextErrors);
      showError(firstFieldError(nextErrors) ?? "Check the form and try again.");
      return;
    }

    setSubmitting(true);
    const result = await registerWithPassword(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      showError(
        result.kind === "network"
          ? "Registration is temporarily unreachable. Check your connection and try again."
          : "We could not create the account. Check your details or try signing in.",
      );
      return;
    }

    router.replace(
      `/verify-email?status=pending&redirect=${encodeURIComponent(safeRedirectPath(redirectTo))}`,
    );
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)} noValidate>
      {formError === undefined ? null : <ErrorSummary ref={summaryRef} message={formError} />}
      <FormField
        id="register-name"
        name="name"
        label="Name"
        autoComplete="name"
        error={errors.name}
        disabled={submitting}
        required
      />
      <FormField
        id="register-email"
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        error={errors.email}
        disabled={submitting}
        required
      />
      <FormField
        id="register-password"
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="Use 8–128 characters with upper and lowercase letters, a number, and a symbol."
        error={errors.password}
        disabled={submitting}
        required
      />
      <FormField
        id="register-password-confirmation"
        name="passwordConfirmation"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        error={errors.passwordConfirmation}
        disabled={submitting}
        required
      />
      {submitting ? <FormStatus>Creating your account…</FormStatus> : null}
      <Button className="w-full" type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? "Creating account…" : "Create account"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href={`/login?redirect=${encodeURIComponent(safeRedirectPath(redirectTo))}`}
          className="font-medium text-primary hover:underline"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
