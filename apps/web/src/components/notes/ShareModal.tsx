"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Share2, UserMinus } from "lucide-react";
import { useState } from "react";

import type { NoteShareList, NoteShareMutationPermission } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { fetchWorkspaceMemberDirectory } from "@/lib/notes/member-directory";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import {
  WORKSPACE_MEMBER_DIRECTORY_LIMIT,
  requestNoteShares,
  revokeNoteShare,
  upsertNoteShare,
} from "@/lib/notes/requests";

function mutationPermission(value: string): NoteShareMutationPermission {
  return value === "edit" ? "edit" : "view";
}

export function ShareModal({
  workspaceId,
  noteId,
  internalPath,
  currentActorId,
}: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly internalPath: string;
  readonly currentActorId: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState("");
  const [permission, setPermission] = useState<NoteShareMutationPermission>("view");
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const members = useQuery({
    queryKey: noteQueryKeys.members(workspaceId),
    enabled: open,
    queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
  });
  const shares = useQuery({
    queryKey: noteQueryKeys.shares(workspaceId, noteId),
    enabled: open,
    queryFn: async (): Promise<NoteShareList> => {
      const result = await requestNoteShares(workspaceId, noteId);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });
  const memberByUserId = new Map(
    (members.data?.items ?? []).map((member) => [member.userId, member]),
  );
  const sharedUserIds = new Set((shares.data?.items ?? []).map((share) => share.userId));
  const candidates = (members.data?.items ?? []).filter(
    (member) => member.userId !== currentActorId && !sharedUserIds.has(member.userId),
  );

  async function save(userId: string, nextPermission: NoteShareMutationPermission): Promise<void> {
    setPendingUserId(userId);
    setStatus("Updating authenticated note access…");
    const result = await upsertNoteShare(workspaceId, noteId, userId, {
      permission: nextPermission,
    });
    setPendingUserId(null);
    if (!result.ok) {
      setStatus(
        result.kind === "forbidden-or-not-found"
          ? "Sharing was denied. The member may lack required workspace or restricted-project access, or your delegation authority changed."
          : "Sharing could not be updated. No grant change was applied.",
      );
      return;
    }
    queryClient.setQueryData<NoteShareList>(
      noteQueryKeys.shares(workspaceId, noteId),
      (current) => {
        const complete = [
          ...(current?.items ?? []).filter((share) => share.userId !== userId),
          result.data.share,
        ];
        const items = complete.slice(0, 1_000);
        return {
          items,
          limit: 1_000,
          returned: items.length,
          truncated: (current?.truncated ?? false) || complete.length > 1_000,
        };
      },
    );
    setTargetUserId("");
    setStatus("Authenticated note access updated.");
  }

  async function revoke(userId: string): Promise<void> {
    setPendingUserId(userId);
    setStatus("Revoking note access…");
    const result = await revokeNoteShare(workspaceId, noteId, userId);
    setPendingUserId(null);
    if (!result.ok) {
      setStatus("Access could not be revoked. The existing list was kept; retry after reloading.");
      return;
    }
    queryClient.setQueryData<NoteShareList>(
      noteQueryKeys.shares(workspaceId, noteId),
      (current) => {
        const items = (current?.items ?? []).filter((share) => share.userId !== userId);
        return {
          items,
          limit: 1_000,
          returned: items.length,
          truncated: current?.truncated ?? false,
        };
      },
    );
    setStatus("Note access revoked. The change applies to the next note request immediately.");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Share2 aria-hidden="true" className="size-4" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share note</DialogTitle>
          <DialogDescription>
            Grant access only to current members of this workspace. Restricted-project access and
            your delegation cap still apply.
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-2" aria-labelledby="internal-link-heading">
          <h3 id="internal-link-heading" className="font-medium">
            Internal link
          </h3>
          <p className="text-sm text-muted-foreground">
            Requires Notted access. This is not a public link and does not bypass workspace,
            project, or note authorization.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="Authenticated internal note link"
              readOnly
              value={internalPath}
              className="min-h-11 min-w-0 flex-1 rounded-md border bg-muted px-3 text-sm"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const url = new URL(internalPath, window.location.origin).toString();
                if (!navigator.clipboard?.writeText) {
                  setStatus("The link could not be copied. Select and copy it manually.");
                  return;
                }
                void navigator.clipboard.writeText(url).then(
                  () => setStatus("Internal link copied. It still requires Notted access."),
                  () => setStatus("The link could not be copied. Select and copy it manually."),
                );
              }}
            >
              <Copy aria-hidden="true" className="size-4" />
              Copy link
            </Button>
          </div>
        </section>
        {members.isPending || shares.isPending ? (
          <p role="status" className="rounded-md bg-muted p-3 text-sm">
            Loading authorized workspace members and current grants…
          </p>
        ) : null}
        {members.isError || shares.isError ? (
          <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            <p>
              Sharing information is unavailable or you no longer have permission to manage this
              note.
            </p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => {
                void members.refetch();
                void shares.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {!members.isPending && !shares.isPending && !members.isError && !shares.isError ? (
          <>
            <section className="space-y-3" aria-labelledby="add-share-heading">
              <h3 id="add-share-heading" className="font-medium">
                Add member access
              </h3>
              {members.data?.hasMore ? (
                <p className="text-sm text-muted-foreground">
                  Member candidates are bounded to the first{" "}
                  {WORKSPACE_MEMBER_DIRECTORY_LIMIT.toLocaleString("en-GB")} authorized workspace
                  members. No omitted member is treated as unauthorized.
                </p>
              ) : null}
              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No additional authorized workspace members are available.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                  <label className="sr-only" htmlFor="share-member">
                    Workspace member
                  </label>
                  <select
                    id="share-member"
                    value={targetUserId}
                    onChange={(event) => setTargetUserId(event.target.value)}
                    disabled={pendingUserId !== null}
                    className="min-h-11 min-w-0 rounded-md border bg-background px-3"
                  >
                    <option value="">Choose a member</option>
                    {candidates.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.name} · {member.role}
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor="share-permission">
                    Permission
                  </label>
                  <select
                    id="share-permission"
                    value={permission}
                    onChange={(event) => setPermission(mutationPermission(event.target.value))}
                    disabled={pendingUserId !== null}
                    className="min-h-11 rounded-md border bg-background px-3"
                  >
                    <option value="view">View</option>
                    <option value="edit">Edit</option>
                  </select>
                  <Button
                    disabled={targetUserId === "" || pendingUserId !== null}
                    onClick={() => void save(targetUserId, permission)}
                  >
                    Grant access
                  </Button>
                </div>
              )}
            </section>
            <section className="space-y-3" aria-labelledby="current-shares-heading">
              <h3 id="current-shares-heading" className="font-medium">
                Current grants
              </h3>
              {shares.data?.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This note has no explicit member grants.
                </p>
              ) : (
                <ul className="space-y-2">
                  {shares.data?.items.map((share) => {
                    const member = memberByUserId.get(share.userId);
                    return (
                      <li
                        key={share.id}
                        className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">
                            {member?.name ?? "Former or unavailable workspace member"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {share.permission === "comment"
                              ? "Comment (existing grant; new UI grants are view/edit only)"
                              : share.permission}
                          </p>
                        </div>
                        <select
                          aria-label={`Permission for ${member?.name ?? share.userId}`}
                          value={share.permission}
                          disabled={pendingUserId !== null || share.permission === "comment"}
                          onChange={(event) =>
                            void save(share.userId, mutationPermission(event.target.value))
                          }
                          className="min-h-11 rounded-md border bg-background px-3"
                        >
                          <option value="view">View</option>
                          {share.permission === "comment" ? (
                            <option value="comment">Comment</option>
                          ) : null}
                          <option value="edit">Edit</option>
                        </select>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pendingUserId !== null}
                          onClick={() => void revoke(share.userId)}
                        >
                          <UserMinus aria-hidden="true" className="size-4" />
                          {pendingUserId === share.userId ? "Revoking…" : "Revoke"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {shares.data?.truncated ? (
                <p className="text-sm text-muted-foreground">
                  Only the first 1,000 grants are shown. Refine membership access administratively
                  before managing additional grants.
                </p>
              ) : null}
            </section>
          </>
        ) : null}
        <p aria-live="polite" aria-atomic="true" className="min-h-6 text-sm text-muted-foreground">
          {status}
        </p>
      </DialogContent>
    </Dialog>
  );
}
