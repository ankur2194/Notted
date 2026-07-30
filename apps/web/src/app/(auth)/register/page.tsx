import { AdvancedSignInMethods } from "@/components/auth/advanced-sign-in-methods";
import { AuthCard } from "@/components/auth/auth-card";
import { RegisterForm } from "@/components/auth/register-form";
import { redirectAuthenticatedFromAuthPage } from "@/lib/auth/auth-page-guard";
import { readRedirectParam } from "@/lib/auth/redirects";
import { getAuthCapabilities } from "@/lib/auth/server-capabilities";

export default async function RegisterPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const redirectTo = readRedirectParam(await searchParams);
  await redirectAuthenticatedFromAuthPage(redirectTo);
  const capabilities = await getAuthCapabilities();
  return (
    <AuthCard
      title="Create your account"
      description="Register with your work email, then verify it before signing in."
    >
      <RegisterForm redirectTo={redirectTo} />
      <AdvancedSignInMethods
        capabilities={capabilities.status === "available" ? capabilities.value : null}
        redirectTo={redirectTo}
      />
    </AuthCard>
  );
}
