"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import type { Editor } from "@tiptap/core";

import {
  createDebouncedSearch,
  createMentionDirectory,
  documentHasMention,
  filterMentionCandidates,
  mentionCandidates,
  type MentionCandidate,
} from "@/components/editor/mention-members";
import { TiptapEditor } from "@/components/editor/TiptapEditor";
import { fetchWorkspaceMemberDirectory } from "@/lib/notes/member-directory";
import { noteQueryKeys } from "@/lib/notes/query-keys";

export interface NoteEditorSurfaceProps {
  /**
   * Always the workspace of the note being edited. It is never derived from a
   * mention query, a URL fragment, or any other caller-supplied value, so the
   * member request can only ever address this workspace. Tenant isolation
   * itself stays where it belongs: `memberships.service.ts#listMembers`.
   */
  readonly workspaceId: string;
  readonly noteId: string;
  readonly initialDocument: unknown;
  readonly editable: boolean;
  readonly ariaLabel?: string;
  readonly readOnlyReason?: string;
  /** Part 39 seam, and how tests drive the real editor through this wrapper. */
  readonly onEditorReady?: (editor: Editor | null) => void;
}

/**
 * Client boundary that gives `TiptapEditor` its workspace-scoped member data.
 *
 * The editor itself performs no I/O: it receives an injected search callback
 * and a directory object. Both are built here from the same authorized member
 * listing the share dialog uses, through TanStack Query, so the list is fetched
 * once per workspace and shared.
 */
export function NoteEditorSurface({
  workspaceId,
  noteId,
  initialDocument,
  editable,
  ariaLabel,
  readOnlyReason,
  onEditorReady,
}: NoteEditorSurfaceProps) {
  const queryClient = useQueryClient();

  // Only notes that already store mentions need the directory on load. Fetching
  // it unconditionally would spend up to `WORKSPACE_MEMBER_MAX_PAGES` sequential
  // requests opening a note that never shows a mention. A disabled query still
  // observes its cache entry, so the first `@` — which populates the same key
  // through `mentionSearch` — fills the directory here too.
  const needsDirectory = useMemo(() => documentHasMention(initialDocument), [initialDocument]);

  const members = useQuery({
    queryKey: noteQueryKeys.members(workspaceId),
    queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
    enabled: needsDirectory,
  });

  // Created once and mutated: node views subscribe to it, and replacing the
  // object would mean rebuilding the editor.
  const directoryRef = useRef(createMentionDirectory());
  const directory = directoryRef.current;

  useEffect(() => {
    // `null` means "not loaded or unavailable", which renders every stored
    // mention neutrally instead of falsely claiming the person was removed.
    if (members.data === undefined) {
      directory.setMembers(null);
      return;
    }
    directory.setMembers(mentionCandidates(members.data));
  }, [directory, members.data]);

  const mentionSearch = useMemo(
    () =>
      createDebouncedSearch<MentionCandidate>(async (query) => {
        const page = await queryClient.fetchQuery({
          queryKey: noteQueryKeys.members(workspaceId),
          queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
        });
        // The member listing has no server-side name filter, so the authorized
        // pages are fetched once, cached under one key, and matched on the
        // client. The query string is therefore never part of a request path.
        return filterMentionCandidates(query, mentionCandidates(page));
      }),
    [queryClient, workspaceId],
  );

  useEffect(() => () => mentionSearch.cancel(), [mentionSearch]);

  return (
    <TiptapEditor
      noteId={noteId}
      initialDocument={initialDocument}
      editable={editable}
      ariaLabel={ariaLabel}
      readOnlyReason={readOnlyReason}
      mentionSearch={mentionSearch}
      mentionDirectory={directory}
      mentionDirectoryTruncated={members.data?.hasMore === true}
      onEditorReady={onEditorReady}
    />
  );
}
