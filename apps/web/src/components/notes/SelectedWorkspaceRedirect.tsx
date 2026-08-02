import Link from "next/link";
import { redirect } from "next/navigation";

import { noteViewPath } from "@/lib/notes/paths";
import { getServerShell } from "@/lib/shell/server-shell";

export async function SelectedWorkspaceRedirect({
  view,
}: {
  readonly view: "templates" | "trash";
}) {
  const shell = await getServerShell();
  if (shell.status === "ready" && shell.data.currentWorkspace !== null) {
    redirect(noteViewPath(shell.data.currentWorkspace.workspaceId, view));
  }
  if (shell.status === "unavailable" || shell.status === "unauthenticated") {
    return (
      <section role="alert" className="mx-auto max-w-3xl rounded-xl border p-6">
        <h1 className="text-3xl font-bold capitalize">{view} unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          Notted could not safely resolve a currently selected authorized workspace.
        </p>
        <Link
          href={`/${view}`}
          className="mt-4 inline-flex min-h-11 items-center rounded-md border px-4 text-sm"
        >
          Retry
        </Link>
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-3xl rounded-xl border p-6">
      <h1 className="text-3xl font-bold capitalize">{view}</h1>
      <p className="mt-2 text-muted-foreground">
        Create or join a workspace before opening this workspace-scoped view.
      </p>
      <Link
        href="/workspaces"
        className="mt-4 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
      >
        View workspaces
      </Link>
    </section>
  );
}
