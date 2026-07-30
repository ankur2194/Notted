"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/requests";

export function LogoutButton() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function logout(): Promise<void> {
    setError(undefined);
    setSubmitting(true);
    const result = await signOut();
    setSubmitting(false);
    if (!result.ok) {
      setError("Sign out failed. Check your connection and try again.");
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      {error === undefined ? null : (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={() => void logout()} disabled={submitting}>
        {submitting ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
