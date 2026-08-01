import Link from "next/link";

export default function WorkspaceNotFound() {
  return (
    <section className="mx-auto max-w-xl space-y-4" role="alert">
      <h1 className="text-2xl font-bold">Workspace not found</h1>
      <p className="text-muted-foreground">
        This workspace does not exist, or you do not have access to it. No workspace details were
        loaded.
      </p>
      <Link
        href="/workspaces"
        className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
      >
        Back to workspaces
      </Link>
    </section>
  );
}
