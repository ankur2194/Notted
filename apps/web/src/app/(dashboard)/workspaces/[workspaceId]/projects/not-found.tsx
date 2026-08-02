import Link from "next/link";

export default function ProjectsNotFound() {
  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">Projects not found</h1>
      <p className="text-muted-foreground">
        This workspace is unavailable or you no longer have access.
      </p>
      <Link
        href="/workspaces"
        className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
      >
        Back to workspaces
      </Link>
    </section>
  );
}
