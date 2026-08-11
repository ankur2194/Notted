import Link from "next/link";

export default function WorkspaceTasksNotFound() {
  return (
    <section className="mx-auto max-w-3xl rounded-xl border p-6">
      <h1 className="text-3xl font-bold">Tasks not found</h1>
      <p className="mt-2 text-muted-foreground">
        This workspace may not exist, or your access to it may have changed. No task was loaded.
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
