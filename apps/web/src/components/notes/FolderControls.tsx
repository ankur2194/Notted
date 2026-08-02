"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { FolderPage, FolderSummary } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import { createFolder, deleteFolder, updateFolder } from "@/lib/notes/requests";

function depths(folders: readonly FolderSummary[]): ReadonlyMap<string, number> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result = new Map<string, number>();
  for (const folder of folders) {
    let depth = 1;
    let parentId = folder.parentId;
    const seen = new Set([folder.id]);
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    result.set(folder.id, depth);
  }
  return result;
}

export function FolderControls({
  workspaceId,
  folders,
  canDelete,
  onStatus,
}: {
  readonly workspaceId: string;
  readonly folders: readonly FolderSummary[];
  readonly canDelete: boolean;
  readonly onStatus: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [deleteOpen, setDeleteOpen] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deleteResultRef = useRef<"success" | null>(null);
  const createNameInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const folderDepths = useMemo(() => depths(folders), [folders]);

  function setFolders(items: readonly FolderSummary[]): void {
    queryClient.setQueryData<FolderPage>(noteQueryKeys.folders(workspaceId), (current) => ({
      items,
      page: current?.page ?? 1,
      limit: current?.limit ?? 100,
      hasMore: current?.hasMore ?? false,
    }));
  }

  useEffect(() => {
    if (createOpen) createNameInputRef.current?.focus();
  }, [createOpen]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  return (
    <section
      className="space-y-3 rounded-xl border bg-card p-4"
      aria-labelledby="folder-controls-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 ref={headingRef} tabIndex={-1} id="folder-controls-heading" className="font-semibold">
            Standalone folders
          </h2>
          <p className="text-sm text-muted-foreground">
            Folders can be nested to three levels. Folders are alphabetical and have no manual
            ordering.
          </p>
        </div>
        <Dialog
          open={createOpen}
          onOpenChange={(open) => pendingId === null && setCreateOpen(open)}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <FolderPlus aria-hidden="true" className="size-4" />
              Create folder
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create folder</DialogTitle>
              <DialogDescription>
                Choose an optional parent. Destinations that would exceed depth three are disabled.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setPendingId("create");
                void createFolder(workspaceId, {
                  name: name.trim(),
                  parentId: parentId === "" ? null : parentId,
                }).then((result) => {
                  setPendingId(null);
                  if (!result.ok) {
                    onStatus("Folder creation failed. No folder was added.");
                    return;
                  }
                  setFolders([...folders, result.data.folder]);
                  setName("");
                  setParentId("");
                  setCreateOpen(false);
                  onStatus("Folder created.");
                });
              }}
            >
              <label className="block space-y-2">
                <span className="text-sm font-medium">Name</span>
                <input
                  ref={createNameInputRef}
                  className="min-h-11 w-full rounded-md border bg-background px-3"
                  value={name}
                  maxLength={255}
                  disabled={pendingId !== null}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Parent folder</span>
                <select
                  className="min-h-11 w-full rounded-md border bg-background px-3"
                  value={parentId}
                  disabled={pendingId !== null}
                  onChange={(event) => setParentId(event.target.value)}
                >
                  <option value="">No parent</option>
                  {folders.map((folder) => (
                    <option
                      key={folder.id}
                      value={folder.id}
                      disabled={(folderDepths.get(folder.id) ?? 3) >= 3}
                    >
                      {folder.name} · level {folderDepths.get(folder.id) ?? 1}
                    </option>
                  ))}
                </select>
              </label>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={pendingId !== null}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={pendingId !== null || name.trim().length === 0}>
                  {pendingId === "create" ? "Creating…" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {folders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folders yet. Notes remain available as unfiled standalone notes.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {folders.map((folder) => (
            <li key={folder.id} className="rounded-lg border p-3">
              {renamingId === folder.id ? (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setPendingId(folder.id);
                    void updateFolder(workspaceId, folder.id, { name: rename.trim() }).then(
                      (result) => {
                        setPendingId(null);
                        if (!result.ok) {
                          onStatus("Folder rename failed. The previous name was kept.");
                          return;
                        }
                        setFolders(
                          folders.map((item) =>
                            item.id === folder.id ? result.data.folder : item,
                          ),
                        );
                        setRenamingId(null);
                        onStatus("Folder renamed.");
                      },
                    );
                  }}
                >
                  <label className="sr-only" htmlFor={`rename-folder-${folder.id}`}>
                    New folder name
                  </label>
                  <input
                    ref={renameInputRef}
                    id={`rename-folder-${folder.id}`}
                    className="min-h-11 rounded-md border bg-background px-3"
                    value={rename}
                    maxLength={255}
                    disabled={pendingId === folder.id}
                    onChange={(event) => setRename(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      type="submit"
                      disabled={pendingId === folder.id || rename.trim().length === 0}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      disabled={pendingId === folder.id}
                      onClick={() => setRenamingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="font-medium">{folder.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Level {folderDepths.get(folder.id) ?? 1}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRenamingId(folder.id);
                        setRename(folder.name);
                      }}
                      disabled={pendingId !== null}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                      Rename
                    </Button>
                    {canDelete ? (
                      <Dialog
                        open={deleteOpen === folder.id}
                        onOpenChange={(open) => {
                          if (pendingId === null) {
                            deleteResultRef.current = null;
                            setDeleteOpen(open ? folder.id : null);
                          }
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button size="sm" variant="outline" disabled={pendingId !== null}>
                            <Trash2 aria-hidden="true" className="size-4" />
                            Delete
                          </Button>
                        </DialogTrigger>
                        <DialogContent
                          onCloseAutoFocus={(event) => {
                            if (deleteResultRef.current === "success") {
                              event.preventDefault();
                              headingRef.current?.focus();
                            }
                          }}
                        >
                          <DialogHeader>
                            <DialogTitle>Delete {folder.name}?</DialogTitle>
                            <DialogDescription>
                              Deleting this folder and its nested folders keeps their notes as
                              unfiled standalone notes. This cannot restore the folder structure.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogClose asChild>
                              <Button variant="outline" disabled={pendingId === folder.id}>
                                Cancel
                              </Button>
                            </DialogClose>
                            <Button
                              variant="destructive"
                              disabled={pendingId === folder.id}
                              onClick={() => {
                                deleteResultRef.current = null;
                                setPendingId(folder.id);
                                void deleteFolder(workspaceId, folder.id).then((result) => {
                                  setPendingId(null);
                                  if (!result.ok) {
                                    onStatus(
                                      "Folder deletion failed. The folder and notes were unchanged.",
                                    );
                                    return;
                                  }
                                  const removed = new Set([folder.id]);
                                  let changed = true;
                                  while (changed) {
                                    changed = false;
                                    for (const item of folders)
                                      if (
                                        item.parentId !== null &&
                                        removed.has(item.parentId) &&
                                        !removed.has(item.id)
                                      ) {
                                        removed.add(item.id);
                                        changed = true;
                                      }
                                  }
                                  setFolders(folders.filter((item) => !removed.has(item.id)));
                                  deleteResultRef.current = "success";
                                  setDeleteOpen(null);
                                  onStatus(
                                    `Folder deleted. ${result.data.unfiledNotes} notes were kept as unfiled.`,
                                  );
                                });
                              }}
                            >
                              {pendingId === folder.id ? "Deleting…" : "Delete folder"}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <span className="self-center text-xs text-muted-foreground">
                        Owner/admin delete only
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
