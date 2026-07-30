"use client";

import { Button } from "@/components/ui/button";

export default function SecuritySettingsError({ reset }: { readonly reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4" role="alert">
      <h1 className="text-2xl font-bold">Security settings could not be displayed</h1>
      <p>No security change was made. Retry when the authentication service is available.</p>
      <Button type="button" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
