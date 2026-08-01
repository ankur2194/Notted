import { uuidSchema } from "@notted/shared-validators";
import { FolderKanban } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { CreateWorkspaceDialog } from "@/components/workspaces/CreateWorkspaceDialog";
import { WorkspaceCard } from "@/components/workspaces/WorkspaceCard";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/shell/server-shell";
import { getServerWorkspaceList } from "@/lib/workspaces/server-workspaces";

interface WorkspacesPageProps {
  readonly searchParams?: Promise<{ readonly page?: string | readonly string[] }>;
}

function requestedPage(value: string | readonly string[] | undefined): number {
  const candidate = typeof value === "string" ? value : value?.[0];
  if (candidate === undefined || !/^\d+$/.test(candidate)) return 1;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : 1;
}

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps = {}) {
  const query = searchParams === undefined ? undefined : await searchParams;
  const page = requestedPage(query?.page);
  const result = await getServerWorkspaceList({ page, limit: 25 });

  // The selection cookie identifies the current workspace (validated by the
  // shell bootstrap). It is only used here for the "Current" badge; selecting a
  // different workspace is handled by WorkspaceCard via the shared cookie
  // helper.
  const cookieStore = await cookies();
  const selection = uuidSchema.safeParse(cookieStore.get(WORKSPACE_SELECTION_COOKIE)?.value);
  const currentWorkspaceId = selection.success ? selection.data : undefined;

  if (result.status === "unavailable" || result.status === "unauthenticated") {
    return (
      <section className="mx-auto max-w-5xl space-y-4" role="alert">
        <h1 className="text-3xl font-bold">Workspaces</h1>
        <p>Your workspaces could not be loaded safely. No content was rendered.</p>
        <Link
          href="/workspaces"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }

  const items = result.data.items;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header
        className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
        aria-labelledby="workspaces-heading"
      >
        <div>
          <h1 id="workspaces-heading" className="text-3xl font-bold tracking-tight">
            Workspaces
          </h1>
          <p className="mt-2 text-muted-foreground">
            Every workspace you can access. Create a new one or open an existing workspace to view
            the controls available to your role.
          </p>
        </div>
        <CreateWorkspaceDialog />
      </header>

      {items.length === 0 && result.data.page === 1 ? (
        <section
          className="space-y-4 rounded-2xl border border-dashed bg-card p-8 text-center shadow-sm"
          aria-labelledby="no-workspaces-heading"
        >
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full bg-muted"
          >
            <FolderKanban className="size-6 text-muted-foreground" />
          </span>
          <h2 id="no-workspaces-heading" className="text-xl font-semibold">
            No workspaces yet
          </h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            Create your first workspace to start organizing projects and notes. You will become its
            owner.
          </p>
          <div className="flex justify-center">
            <CreateWorkspaceDialog triggerLabel="Create your first workspace" />
          </div>
        </section>
      ) : items.length === 0 ? (
        <section
          className="space-y-4 rounded-2xl border border-dashed bg-card p-8 text-center shadow-sm"
          aria-labelledby="no-workspaces-page-heading"
        >
          <h2 id="no-workspaces-page-heading" className="text-xl font-semibold">
            No workspaces on this page
          </h2>
          <p className="text-sm text-muted-foreground">
            Your memberships may have changed, or this page is past the end of the list.
          </p>
          <Link
            href="/workspaces"
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            Return to the first page
          </Link>
        </section>
      ) : (
        <ul className="space-y-3" aria-label="Your workspaces">
          {items.map((workspace) => (
            <li key={workspace.id}>
              <WorkspaceCard workspace={workspace} currentWorkspaceId={currentWorkspaceId} />
            </li>
          ))}
        </ul>
      )}

      {result.data.page > 1 || result.data.hasMore ? (
        <nav className="flex items-center justify-between gap-4" aria-label="Workspace pages">
          {result.data.page > 1 ? (
            <Link
              href={`/workspaces?page=${result.data.page - 1}`}
              className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">Page {result.data.page}</span>
          {result.data.hasMore ? (
            <Link
              href={`/workspaces?page=${result.data.page + 1}`}
              className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <nav className="text-sm text-muted-foreground" aria-label="Workspace navigation help">
        <p>
          Switch your active workspace from the sidebar, or{" "}
          <Link href="/" className="font-medium text-primary hover:underline">
            return to the dashboard
          </Link>
          .
        </p>
      </nav>
    </div>
  );
}
