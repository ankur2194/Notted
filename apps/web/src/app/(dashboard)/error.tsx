"use client";

import { Button } from "@/components/ui/button";

export default function DashboardError({ reset }: { readonly reset: () => void }) {
  return (
    <main id="main-content" className="grid min-h-dvh place-items-center px-4">
      <div className="max-w-md rounded-xl border bg-card p-8 text-center shadow-sm" role="alert">
        <h1 className="text-2xl font-bold">Notted could not open the workspace</h1>
        <p className="mt-3 text-muted-foreground">
          Your protected content was not displayed. Check your connection and try again.
        </p>
        <Button className="mt-5" onClick={reset}>
          Retry application shell
        </Button>
      </div>
    </main>
  );
}
