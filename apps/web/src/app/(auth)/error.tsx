"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AuthError({ reset }: { readonly reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md items-center px-4">
      <div className="space-y-4 rounded-xl border border-border p-8 text-center" role="alert">
        <h1 className="text-2xl font-bold">Authentication page unavailable</h1>
        <p className="text-muted-foreground">
          No credentials were submitted. Retry this page or return to sign in.
        </p>
        <div className="flex justify-center gap-3">
          <Button type="button" onClick={reset}>
            Retry
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
