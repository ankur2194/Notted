export default function SecuritySettingsLoading() {
  return (
    <div
      className="mx-auto max-w-4xl space-y-4"
      role="status"
      aria-label="Loading security settings"
    >
      <div className="h-10 w-64 animate-pulse rounded bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
