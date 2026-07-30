import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { readRedirectParam } from "@/lib/auth/redirects";

export default async function MagicLinkResultPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const params = await searchParams;
  const redirectTo = readRedirectParam(params);
  const status = Array.isArray(params.status) ? params.status[0] : params.status;
  const hasError = params.error !== undefined || status !== "success";

  return (
    <AuthCard
      title={hasError ? "Sign-in link unavailable" : "Signed in securely"}
      description={
        hasError
          ? "This link is invalid, expired, or has already been used."
          : "Your one-time sign-in link was accepted."
      }
    >
      <div className="space-y-4">
        <p className="rounded-md bg-muted p-4 text-sm" role="status" aria-live="polite">
          {hasError
            ? "Request a new link from the sign-in page. Only the newest unused link will work."
            : "You can continue to the protected application. Refreshing it will validate the same server session."}
        </p>
        <Link
          href={hasError ? `/login?redirect=${encodeURIComponent(redirectTo)}` : redirectTo}
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          {hasError ? "Request another sign-in link" : "Continue to Notted"}
        </Link>
      </div>
    </AuthCard>
  );
}
