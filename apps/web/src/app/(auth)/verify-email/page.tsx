import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { redirectAuthenticatedFromAuthPage } from "@/lib/auth/auth-page-guard";
import { readRedirectParam } from "@/lib/auth/redirects";

export default async function VerifyEmailPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const params = await searchParams;
  const redirectTo = readRedirectParam(params);
  await redirectAuthenticatedFromAuthPage(redirectTo);
  const statusValue = Array.isArray(params.status) ? params.status[0] : params.status;
  const errorValue = Array.isArray(params.error) ? params.error[0] : params.error;
  const pending = statusValue === "pending";
  const failed = errorValue !== undefined || statusValue === "error";

  return (
    <AuthCard
      title={
        pending ? "Check your email" : failed ? "Verification link unavailable" : "Email verified"
      }
      description={
        pending
          ? "Open the newest verification email to finish registration."
          : failed
            ? "This link is invalid, expired, or has already been used."
            : "Your address is verified. You can now sign in."
      }
    >
      <div className="space-y-4">
        <div
          className={`rounded-md border p-4 ${failed ? "border-warning bg-warning/5" : "border-success bg-success/5"}`}
          role="status"
          aria-live="polite"
        >
          <p className="text-sm">
            {pending
              ? "Delivery can take a moment. If no message arrives, request another below."
              : failed
                ? "For your security, request a fresh verification email."
                : "Verification succeeded. Your password was not used to create a session automatically."}
          </p>
        </div>
        {!pending && !failed ? (
          <Link
            href={`/login?redirect=${encodeURIComponent(redirectTo)}`}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Continue to sign in
          </Link>
        ) : null}
        <ResendVerificationForm redirectTo={redirectTo} />
      </div>
    </AuthCard>
  );
}
