import Link from "next/link";

export default function ProjectNoteNotFound() {
  return (
    <section className="mx-auto max-w-3xl rounded-xl border p-6">
      <h1 className="text-3xl font-bold">Project note not found</h1>
      <p className="mt-2 text-muted-foreground">
        The note, project, or matching relationship is unavailable or concealed by current access.
      </p>
      <Link
        href="/workspaces"
        className="mt-4 inline-flex min-h-11 items-center rounded-md border px-4 text-sm"
      >
        Choose a workspace
      </Link>
    </section>
  );
}
