export default function WorkspaceSettingsLoading() {
  return (
    <div
      className="mx-auto max-w-3xl space-y-6"
      role="status"
      aria-label="Loading workspace settings"
    >
      <div className="h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="h-10 w-64 animate-pulse rounded bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
