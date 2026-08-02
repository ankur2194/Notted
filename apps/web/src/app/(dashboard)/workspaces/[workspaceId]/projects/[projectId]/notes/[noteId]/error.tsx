"use client";

import { Button } from "@/components/ui/button";

export default function ProjectNoteError({ reset }: { readonly reset: () => void }) {
  return (
    <section role="alert" className="mx-auto max-w-4xl rounded-xl border p-6">
      <h1 className="text-3xl font-bold">Project note could not be displayed</h1>
      <p className="mt-2 text-muted-foreground">
        The note route failed without rendering project or note content.
      </p>
      <Button className="mt-4" onClick={reset}>
        Retry
      </Button>
    </section>
  );
}
