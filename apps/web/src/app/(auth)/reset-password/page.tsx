import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { redirectAuthenticatedFromAuthPage } from "@/lib/auth/auth-page-guard";

// eslint-disable-next-line no-control-regex -- security-positive: rejects C0 control chars and DEL from reset tokens before they reach Better Auth
const RESET_TOKEN_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export default async function ResetPasswordPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  await redirectAuthenticatedFromAuthPage();
  const rawToken = (await searchParams).token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const usableToken =
    token !== undefined &&
    token.length >= 32 &&
    token.length <= 512 &&
    !RESET_TOKEN_CONTROL_CHARACTER_PATTERN.test(token);

  return (
    <AuthCard
      title="Choose a new password"
      description="A successful reset signs out every existing session for this account."
    >
      {usableToken ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-warning bg-warning/5 p-4" role="alert">
            <h2 className="font-semibold">This reset link is invalid or expired</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Request a new email and use only the most recent link.
            </p>
          </div>
          <Link
            href="/forgot-password"
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Request a new reset link
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
