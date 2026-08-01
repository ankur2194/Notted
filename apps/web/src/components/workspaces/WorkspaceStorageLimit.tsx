function formatBinaryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)} ${units[unitIndex] ?? "PiB"}`;
}

/**
 * Shows a concise binary size visually while exposing the exact byte count to
 * assistive technology. A null value is a real plan-managed state, not missing
 * data.
 */
export function WorkspaceStorageLimit({ bytes }: { readonly bytes: number | null }) {
  if (bytes === null) return <>Plan-managed limit</>;

  return (
    <>
      <span aria-hidden="true">{formatBinaryBytes(bytes)}</span>
      <span className="sr-only">{new Intl.NumberFormat("en").format(bytes)} bytes</span>
    </>
  );
}
