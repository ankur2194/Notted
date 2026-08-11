"use client";

import { Button } from "@/components/ui/button";

export default function WorkspaceTasksError({ reset }: { readonly reset: () => void }) {
  return (
    <section role="alert" className="mx-auto max-w-4xl rounded-xl border p-6">
      <h1 className="text-3xl font-bold">Tasks could not be displayed</h1>
      <p className="mt-2 text-muted-foreground">
        The task route failed without rendering any task. No task was changed, and the rest of the
        shell remains available.
      </p>
      <Button className="mt-4" onClick={reset}>
        Retry
      </Button>
    </section>
  );
}
