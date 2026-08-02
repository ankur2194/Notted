"use client";

import { Button } from "@/components/ui/button";

export default function ProjectsError({ reset }: { readonly reset: () => void }) {
  return (
    <section className="mx-auto max-w-3xl space-y-4" role="alert">
      <h1 className="text-2xl font-bold">Projects could not be displayed</h1>
      <p>An unexpected rendering error occurred. Retry the server-owned project read.</p>
      <Button type="button" onClick={reset}>
        Retry
      </Button>
    </section>
  );
}
