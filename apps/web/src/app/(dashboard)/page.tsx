import { FileText, FolderKanban, Sparkles } from "lucide-react";

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section
        aria-labelledby="dashboard-heading"
        className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8"
      >
        <p className="text-sm font-medium text-info">Workspace overview</p>
        <h1 id="dashboard-heading" className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Welcome back
        </h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Your authenticated workspace shell is ready. Project and note content will appear here as
          their owning parts are implemented.
        </p>
      </section>

      <section aria-labelledby="workspace-content-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="workspace-content-heading" className="text-xl font-semibold">
              Workspace content
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Feature areas are shown without fabricated records.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <article className="rounded-xl border bg-card p-5">
            <FolderKanban className="size-5 text-info" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">Projects</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Project screens and data arrive in Parts 29–30.
            </p>
            <span className="mt-4 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-medium">
              Unavailable
            </span>
          </article>
          <article className="rounded-xl border bg-card p-5">
            <FileText className="size-5 text-info" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">Notes</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              The note tree and note APIs arrive in Parts 31–32.
            </p>
            <span className="mt-4 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-medium">
              Unavailable
            </span>
          </article>
          <article className="rounded-xl border bg-card p-5">
            <Sparkles className="size-5 text-info" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">Search</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Full-text and semantic search arrive in Parts 50–52.
            </p>
            <span className="mt-4 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-medium">
              Unavailable
            </span>
          </article>
        </div>
      </section>
    </div>
  );
}
