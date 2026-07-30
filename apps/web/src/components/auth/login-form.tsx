"use client";

import { signInWithPasswordSchema } from "@notted/shared-validators";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { fieldErrorsFromZod, firstFieldError, type FieldErrors } from "@/lib/auth/form-errors";
import { safeRedirectPath } from "@/lib/auth/redirects";
import { signInWithPassword } from "@/lib/auth/requests";

export function LoginForm({
  redirectTo = "/",
  rememberedDays = 30,
}: {
  readonly redirectTo?: string;
  readonly rememberedDays?: number;
}) {
  const router = useRouter();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function focusSummary(): void {
    requestAnimationFrame(() => summaryRef.current?.focus());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});
    setFormError(undefined);
    const data = new FormData(event.currentTarget);
    const parsed = signInWithPasswordSchema.safeParse({
      email: data.get("email"),
      password: data.get("password"),
      rememberMe: data.get("rememberMe") === "on",
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFromZod(parsed.error));
      setFormError(firstFieldError(fieldErrorsFromZod(parsed.error)));
      focusSummary();
      return;
    }

    setSubmitting(true);
    const result = await signInWithPassword(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFormError(
        result.kind === "network"
          ? "Authentication is temporarily unreachable. Check your connection and try again."
          : "Unable to sign in. Check your email and password and try again.",
      );
      focusSummary();
      return;
    }

    if (result.next === "two-factor") {
      const methods = (result.methods ?? []).filter((method) => method === "totp").join(",");
      router.replace(
        `/two-factor?redirect=${encodeURIComponent(safeRedirectPath(redirectTo))}&methods=${encodeURIComponent(methods)}`,
      );
      return;
    }

    router.replace(safeRedirectPath(redirectTo));
    router.refresh();
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)} noValidate>
      {formError === undefined ? null : <ErrorSummary ref={summaryRef} message={formError} />}
      <FormField
        id="login-email"
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
        id="login-password"
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        error={errors.password}
        disabled={submitting}
        required
      />
      <div className="flex items-center justify-between gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input name="rememberMe" type="checkbox" disabled={submitting} />
          Remember this browser for {rememberedDays} days
        </label>
        <Link href="/forgot-password" className="font-medium text-primary hover:underline">
          Forgot password?
        </Link>
      </div>
      {submitting ? <FormStatus>Signing in…</FormStatus> : null}
      <Button className="w-full" type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        New to Notted?{" "}
        <Link
          href={`/register?redirect=${encodeURIComponent(safeRedirectPath(redirectTo))}`}
          className="font-medium text-primary hover:underline"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}
