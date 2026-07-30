import { AdvancedSignInMethods } from "@/components/auth/advanced-sign-in-methods";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { MagicLinkForm } from "@/components/auth/magic-link-form";
import { redirectAuthenticatedFromAuthPage } from "@/lib/auth/auth-page-guard";
import { readRedirectParam } from "@/lib/auth/redirects";
import { getAuthCapabilities } from "@/lib/auth/server-capabilities";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const redirectTo = readRedirectParam(resolvedSearchParams);
  const oauthFailed = resolvedSearchParams.oauth === "error";
  await redirectAuthenticatedFromAuthPage(redirectTo);
  const capabilities = await getAuthCapabilities();

  return (
    <AuthCard title="Sign in" description="Use your password or request a one-time email link.">
      {oauthFailed ? (
        <p className="text-sm text-destructive" role="alert">
          Social sign-in could not be completed. Try again or use another sign-in method.
        </p>
      ) : null}
      <LoginForm
        redirectTo={redirectTo}
        rememberedDays={
          capabilities.status === "available"
            ? Math.round(capabilities.value.rememberedSessionSeconds / 86_400)
            : 30
        }
      />
      <AdvancedSignInMethods
        capabilities={capabilities.status === "available" ? capabilities.value : null}
        redirectTo={redirectTo}
      />
      <MagicLinkForm redirectTo={redirectTo} />
    </AuthCard>
  );
}
