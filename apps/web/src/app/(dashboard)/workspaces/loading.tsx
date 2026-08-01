export default function WorkspacesLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6" role="status" aria-label="Loading workspaces">
      <div className="h-10 w-48 animate-pulse rounded bg-muted" />
      <div className="space-y-3">
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
