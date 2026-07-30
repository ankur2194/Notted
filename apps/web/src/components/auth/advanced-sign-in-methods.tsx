"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { AuthCapabilities, OAuthProviderId } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import { publicEnvironment } from "@/config/public-environment";
import { safeRedirectPath } from "@/lib/auth/redirects";
import { signInWithOAuth, signInWithPasskey } from "@/lib/auth/requests";

interface AdvancedSignInMethodsProps {
  readonly capabilities: AuthCapabilities | null;
  readonly redirectTo: string;
}

export function AdvancedSignInMethods({ capabilities, redirectTo }: AdvancedSignInMethodsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<OAuthProviderId | "passkey">();
  const [error, setError] = useState<string>();
  const [passkeySupport, setPasskeySupport] = useState<"checking" | "ready" | "unsupported">(
    "checking",
  );

  useEffect(() => {
    setPasskeySupport(
      window.isSecureContext && "PublicKeyCredential" in window ? "ready" : "unsupported",
    );
  }, []);

  if (capabilities === null) {
    return (
      <p className="text-center text-sm text-muted-foreground" role="status">
        Additional sign-in methods are temporarily unavailable. Email sign-in still works.
      </p>
    );
  }

  const localPath = safeRedirectPath(redirectTo);
  const callbackURL = new URL(localPath, publicEnvironment.NEXT_PUBLIC_APP_URL).toString();
  const errorCallbackURL = new URL("/login", publicEnvironment.NEXT_PUBLIC_APP_URL);
  errorCallbackURL.searchParams.set("oauth", "error");
  errorCallbackURL.searchParams.set("redirect", localPath);

  async function oauth(provider: OAuthProviderId): Promise<void> {
    setError(undefined);
    setBusy(provider);
    const result = await signInWithOAuth(provider, callbackURL, errorCallbackURL.toString());
    if (!result.ok) {
      setError("Social sign-in could not be started. Try again.");
      setBusy(undefined);
    }
  }

  async function passkey(): Promise<void> {
    setError(undefined);
    setBusy("passkey");
    const result = await signInWithPasskey();
    setBusy(undefined);
    if (!result.ok) {
      setError("Passkey sign-in was cancelled or could not be completed.");
      return;
    }
    router.replace(localPath);
    router.refresh();
  }

  const showAny = capabilities.oauthProviders.length > 0 || capabilities.passkeyEnabled;
  if (!showAny) return null;

  return (
    <section
      className="space-y-3 border-t border-border pt-5"
      aria-label="Additional sign-in methods"
    >
      {error === undefined ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {capabilities.oauthProviders.map((provider) => (
        <Button
          key={provider.id}
          className="w-full"
          type="button"
          variant="outline"
          disabled={busy !== undefined}
          onClick={() => void oauth(provider.id)}
        >
          Continue with {provider.label}
        </Button>
      ))}
      {capabilities.passkeyEnabled ? (
        <>
          <Button
            className="w-full"
            type="button"
            variant="outline"
            disabled={busy !== undefined || passkeySupport !== "ready"}
            onClick={() => void passkey()}
          >
            {busy === "passkey" ? "Waiting for passkey…" : "Sign in with a passkey"}
          </Button>
          {passkeySupport === "unsupported" ? (
            <p className="text-sm text-muted-foreground">
              Passkeys require a supported browser in a secure HTTPS context (localhost is allowed
              for development).
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
