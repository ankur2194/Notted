import { SecuritySettings } from "@/components/settings/security-settings";
import { getAuthCapabilities } from "@/lib/auth/server-capabilities";

export default async function SecuritySettingsPage() {
  const capabilities = await getAuthCapabilities();
  if (capabilities.status === "unavailable") {
    return (
      <section className="mx-auto max-w-4xl space-y-4" role="alert">
        <h1 className="text-3xl font-bold">Security settings</h1>
        <p>Authentication configuration is temporarily unavailable. No settings were loaded.</p>
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Security settings</h1>
        <p className="mt-2 text-muted-foreground">
          Manage two-factor authentication, passkeys, and active sessions.
        </p>
      </div>
      <SecuritySettings capabilities={capabilities.value} />
    </section>
  );
}
