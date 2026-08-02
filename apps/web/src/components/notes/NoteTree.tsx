"use client";

import { ChevronRight, FileCheck2, FileText, Folder, FolderKanban } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { NoteTreeNode } from "@/lib/notes/tree";
import type { FolderSummary, NoteNavigation } from "@notted/shared-types";

import { noteCollectionPath, noteDetailPath } from "@/lib/notes/paths";
import { buildNoteTree } from "@/lib/notes/tree";

export type NoteNavigationState =
  | {
      readonly status: "ready";
      readonly navigation: NoteNavigation;
      readonly folders: readonly FolderSummary[];
      readonly foldersTruncated?: boolean;
    }
  | { readonly status: "no-workspace" }
  | { readonly status: "unavailable" };

function Disclosure({
  label,
  children,
  level,
  name,
  selectedNoteId,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly level: number;
  readonly name: string;
  readonly selectedNoteId?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-expanded={expanded}
      aria-selected={selectedNoteId ? "true" : "false"}
    >
      <div className="flex min-h-11 items-center gap-1 rounded hover:bg-accent">
        <button
          type="button"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" && !expanded) {
              event.preventDefault();
              setExpanded(true);
            }
            if (event.key === "ArrowLeft" && expanded) {
              event.preventDefault();
              setExpanded(false);
            }
          }}
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        {label}
      </div>
      {expanded ? children : null}
    </li>
  );
}

function Nodes({
  workspaceId,
  nodes,
  level = 1,
  selectedNoteId,
}: {
  readonly workspaceId: string;
  readonly nodes: readonly NoteTreeNode[];
  readonly level?: number;
  readonly selectedNoteId?: string;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul role={level === 1 ? "tree" : "group"} className="space-y-1 ps-2">
      {nodes.map(({ note, children }) =>
        children.length > 0 ? (
          <Disclosure
            key={note.id}
            level={level}
            name={note.title}
            selectedNoteId={selectedNoteId}
            label={
              <Link
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={noteDetailPath(workspaceId, note)}
              >
                {note.type === "task-list" ? (
                  <FileCheck2 aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                )}
                <span className="truncate">{note.title}</span>
              </Link>
            }
          >
            <Nodes
              workspaceId={workspaceId}
              nodes={children}
              level={level + 1}
              selectedNoteId={selectedNoteId}
            />
          </Disclosure>
        ) : (
          <li
            key={note.id}
            role="treeitem"
            aria-level={level}
            aria-selected={note.id === selectedNoteId ? "true" : "false"}
          >
            <Link
              className="flex min-h-11 items-center gap-2 rounded px-11 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={noteDetailPath(workspaceId, note)}
            >
              {note.type === "task-list" ? (
                <FileCheck2 aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <FileText aria-hidden="true" className="size-4 shrink-0" />
              )}
              <span className="truncate">{note.title}</span>
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}

export function NoteTree({
  workspaceId,
  state,
}: {
  readonly workspaceId: string | null;
  readonly state: NoteNavigationState;
}) {
  if (state.status === "no-workspace" || workspaceId === null) {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Choose or create a workspace to browse notes.
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <div
        className="space-y-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground"
        role="status"
      >
        <p>Note navigation is temporarily unavailable. Other workspace tools remain available.</p>
        <Link
          className="font-medium text-foreground underline"
          href={noteCollectionPath(workspaceId)}
        >
          Open full note browser
        </Link>
      </div>
    );
  }

  const groups = buildNoteTree(state.navigation.items);
  const foldersByParent = new Map<string | null, FolderSummary[]>();
  for (const folder of state.folders) {
    const items = foldersByParent.get(folder.parentId) ?? [];
    items.push(folder);
    foldersByParent.set(folder.parentId, items);
  }
  const selectedNoteId = (state.navigation as { selectedNoteId?: string }).selectedNoteId;
  const renderFolder = (folder: FolderSummary, ancestry: ReadonlySet<string>) => {
    if (ancestry.has(folder.id)) return null;
    const next = new Set(ancestry).add(folder.id);
    const children = (foldersByParent.get(folder.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const folderNotes = groups.standalone.get(folder.id) ?? [];
    return (
      <Disclosure
        key={folder.id}
        level={2}
        name={folder.name}
        selectedNoteId={selectedNoteId}
        label={
          <Link
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={`${noteCollectionPath(workspaceId)}?folderId=${encodeURIComponent(folder.id)}`}
          >
            <Folder aria-hidden="true" className="size-4" />
            <span className="truncate">{folder.name}</span>
          </Link>
        }
      >
        <Nodes
          workspaceId={workspaceId}
          nodes={folderNotes}
          level={3}
          selectedNoteId={selectedNoteId}
        />
        {children.length > 0 ? (
          <ul role="group" className="ps-2">
            {children.map((child) => renderFolder(child, next))}
          </ul>
        ) : null}
      </Disclosure>
    );
  };

  return (
    <div className="space-y-3 text-sm">
      <ul role="tree" aria-label="Project notes">
        <Disclosure
          level={1}
          name="project notes"
          selectedNoteId={selectedNoteId}
          label={
            <span className="flex min-h-11 flex-1 items-center gap-2 px-2 text-xs font-semibold uppercase tracking-wide">
              <FolderKanban aria-hidden="true" className="size-4" />
              Project notes
            </span>
          }
        >
          {groups.projects.size === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No visible project notes.</p>
          ) : (
            <ul role="group" className="space-y-1 ps-2">
              {[...groups.projects].map(([projectId, nodes]) => (
                <Disclosure
                  key={projectId}
                  level={2}
                  name={`project ${projectId.slice(0, 8)}`}
                  selectedNoteId={selectedNoteId}
                  label={
                    <Link
                      className="flex min-h-11 flex-1 items-center rounded px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      href={`/workspaces/${workspaceId}/projects/${projectId}`}
                    >
                      Project {projectId.slice(0, 8)}
                    </Link>
                  }
                >
                  <Nodes
                    workspaceId={workspaceId}
                    nodes={nodes}
                    level={3}
                    selectedNoteId={selectedNoteId}
                  />
                </Disclosure>
              ))}
            </ul>
          )}
        </Disclosure>
      </ul>
      <ul role="tree" aria-label="Standalone notes">
        <Disclosure
          level={1}
          name="standalone notes"
          selectedNoteId={selectedNoteId}
          label={
            <Link
              className="flex min-h-11 flex-1 items-center gap-2 rounded px-2 text-xs font-semibold uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={noteCollectionPath(workspaceId)}
            >
              <FileText aria-hidden="true" className="size-4" />
              Standalone notes
            </Link>
          }
        >
          <Nodes
            workspaceId={workspaceId}
            nodes={groups.standalone.get("unfiled") ?? []}
            level={2}
            selectedNoteId={selectedNoteId}
          />
          <ul role="group" className="space-y-1 ps-2">
            {(foldersByParent.get(null) ?? [])
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((folder) => renderFolder(folder, new Set()))}
          </ul>
        </Disclosure>
      </ul>
      {state.navigation.truncated ? (
        <p className="rounded-md bg-muted p-2 text-xs">
          Navigation is truncated at {state.navigation.limit} notes.{" "}
          <Link className="font-medium underline" href={noteCollectionPath(workspaceId)}>
            Open the full note browser
          </Link>
          .
        </p>
      ) : null}
      {state.foldersTruncated ? (
        <p className="rounded-md bg-muted p-2 text-xs">
          The folder projection is truncated.{" "}
          <Link className="font-medium underline" href={noteCollectionPath(workspaceId)}>
            Open the full note browser
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
