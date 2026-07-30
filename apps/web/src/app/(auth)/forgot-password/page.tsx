import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { redirectAuthenticatedFromAuthPage } from "@/lib/auth/auth-page-guard";

export default async function ForgotPasswordPage() {
  await redirectAuthenticatedFromAuthPage();
  return (
    <AuthCard
      title="Reset your password"
      description="Enter your email. We will send instructions when the address can be used."
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
