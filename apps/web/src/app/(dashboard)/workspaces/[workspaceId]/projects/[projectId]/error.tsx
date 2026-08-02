"use client";

import { Button } from "@/components/ui/button";

export default function ProjectDetailError({ reset }: { readonly reset: () => void }) {
  return (
    <section className="mx-auto max-w-3xl space-y-4" role="alert">
      <h1 className="text-2xl font-bold">Project could not be displayed</h1>
      <p>An unexpected rendering error occurred.</p>
      <Button type="button" onClick={reset}>
        Retry
      </Button>
    </section>
  );
}
