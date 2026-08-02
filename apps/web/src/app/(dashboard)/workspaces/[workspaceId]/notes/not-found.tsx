import Link from "next/link";

export default function NoteNotFound() {
  return (
    <section className="mx-auto max-w-3xl rounded-xl border p-6">
      <h1 className="text-3xl font-bold">Note or note collection not found</h1>
      <p className="mt-2 text-muted-foreground">
        The note may not exist, may belong to another workspace or restricted project, or your
        access may have changed.
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
