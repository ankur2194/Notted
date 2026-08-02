import type { NoteNavigationItem, NoteSummary } from "@notted/shared-types";

export interface NoteTreeNode {
  readonly note: NoteNavigationItem;
  readonly children: readonly NoteTreeNode[];
}

export interface NoteTreeGroups {
  readonly projects: ReadonlyMap<string, readonly NoteTreeNode[]>;
  readonly standalone: ReadonlyMap<string, readonly NoteTreeNode[]>;
}

function compareNotes(left: NoteNavigationItem, right: NoteNavigationItem): number {
  return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
}

function rootsFor(items: readonly NoteNavigationItem[]): readonly NoteTreeNode[] {
  const scopedIds = new Set(items.map((item) => item.id));
  const children = new Map<string | null, NoteNavigationItem[]>();
  for (const item of items) {
    const parent = item.parentId !== null && scopedIds.has(item.parentId) ? item.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(item);
    children.set(parent, siblings);
  }
  const build = (parentId: string | null, ancestry: ReadonlySet<string>): NoteTreeNode[] =>
    (children.get(parentId) ?? []).sort(compareNotes).flatMap((note) => {
      if (ancestry.has(note.id)) return [];
      const next = new Set(ancestry).add(note.id);
      return [{ note, children: build(note.id, next) }];
    });
  return build(null, new Set());
}

export function buildNoteTree(items: readonly NoteNavigationItem[]): NoteTreeGroups {
  const projects = new Map<string, NoteNavigationItem[]>();
  const standalone = new Map<string, NoteNavigationItem[]>();
  for (const item of items) {
    const target = item.projectId === null ? standalone : projects;
    const key = item.projectId ?? item.folderId ?? "unfiled";
    const group = target.get(key) ?? [];
    group.push(item);
    target.set(key, group);
  }
  const projectTrees = new Map<string, readonly NoteTreeNode[]>();
  const standaloneTrees = new Map<string, readonly NoteTreeNode[]>();
  for (const [key, groupedNotes] of projects) projectTrees.set(key, rootsFor(groupedNotes));
  for (const [key, groupedNotes] of standalone) standaloneTrees.set(key, rootsFor(groupedNotes));
  return { projects: projectTrees, standalone: standaloneTrees };
}

export function cloneNotePageItems(items: readonly NoteSummary[]): NoteSummary[] {
  return items.map((item) => ({ ...item, tagIds: [...item.tagIds] }));
}

export function optimisticMove(
  items: readonly NoteSummary[],
  noteId: string,
  destination: {
    readonly projectId: string | null;
    readonly folderId: string | null;
    readonly parentId: string | null;
  },
  beforeNoteId: string | null,
): NoteSummary[] {
  const moved = items.find((item) => item.id === noteId);
  if (moved === undefined) return cloneNotePageItems(items);
  const descendants = new Set<string>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of items) {
      if (
        item.parentId !== null &&
        (item.parentId === noteId || descendants.has(item.parentId)) &&
        !descendants.has(item.id)
      ) {
        descendants.add(item.id);
        expanded = true;
      }
    }
  }
  const location: NoteSummary["location"] =
    destination.projectId === null ? "workspace-root" : "project";
  const remaining: NoteSummary[] = items
    .filter((item) => item.id !== noteId)
    .map((item): NoteSummary =>
      descendants.has(item.id)
        ? {
            ...item,
            projectId: destination.projectId,
            folderId: destination.folderId,
            location,
            tagIds: [...item.tagIds],
          }
        : { ...item, tagIds: [...item.tagIds] },
    );
  const next: NoteSummary = { ...moved, ...destination, location, tagIds: [...moved.tagIds] };
  const beforeIndex =
    beforeNoteId === null ? -1 : remaining.findIndex((item) => item.id === beforeNoteId);
  if (beforeIndex < 0) remaining.push(next);
  else remaining.splice(beforeIndex, 0, next);
  return remaining.map((item, index) => ({ ...item, sortOrder: index + 1 }));
}
