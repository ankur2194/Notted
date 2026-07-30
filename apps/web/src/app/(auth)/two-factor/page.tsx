import { AuthCard } from "@/components/auth/auth-card";
import { TwoFactorChallenge } from "@/components/auth/two-factor-challenge";
import { readRedirectParam } from "@/lib/auth/redirects";

export default async function TwoFactorPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const redirectTo = readRedirectParam(await searchParams);
  return (
    <AuthCard
      title="Two-factor verification"
      description="Confirm this sign-in with your authenticator or a one-time recovery code."
    >
      <TwoFactorChallenge redirectTo={redirectTo} />
    </AuthCard>
  );
}
