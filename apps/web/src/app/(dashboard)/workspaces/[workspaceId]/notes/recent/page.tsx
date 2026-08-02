import type { NoteSearchParams } from "@/lib/notes/server-notes";

import { WorkspaceNoteBrowser } from "@/components/notes/WorkspaceNoteBrowser";

export default async function RecentNotesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<NoteSearchParams>;
}) {
  const { workspaceId } = await params;
  return (
    <WorkspaceNoteBrowser
      workspaceId={workspaceId}
      searchParams={await searchParams}
      view="recent"
    />
  );
}
