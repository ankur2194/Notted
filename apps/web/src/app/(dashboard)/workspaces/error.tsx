"use client";

import { Button } from "@/components/ui/button";

export default function WorkspacesError({ reset }: { readonly reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4" role="alert">
      <h1 className="text-2xl font-bold">Workspaces could not be displayed</h1>
      <p>No workspace was created or changed. Retry when the service is available.</p>
      <Button type="button" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
