export default function WorkspaceOverviewLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6" role="status" aria-label="Loading workspace">
      <div className="h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
