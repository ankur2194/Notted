import { exactByteLabel, formatBinaryBytes } from "@/lib/notes/format-bytes";

/**
 * Shows a concise binary size visually while exposing the exact byte count to
 * assistive technology. A null value is a real plan-managed state, not missing
 * data.
 *
 * Part 44 moved the formatter out of this file: the attachment card needs the
 * identical rendering, and Part 45's workspace usage display will need it too.
 * The a11y shape is unchanged — rounded value hidden from screen readers, exact
 * count in a visually hidden span.
 */
export function WorkspaceStorageLimit({ bytes }: { readonly bytes: number | null }) {
  if (bytes === null) return <>Plan-managed limit</>;

  return (
    <>
      <span aria-hidden="true">{formatBinaryBytes(bytes)}</span>
      <span className="sr-only">{exactByteLabel(bytes)}</span>
    </>
  );
}
