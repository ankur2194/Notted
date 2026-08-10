"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, GripVertical } from "lucide-react";
import { useEffect, useState } from "react";

import { NoteCard } from "./NoteCard";

import type { FolderSummary, NoteSummary, TagSummary } from "@notted/shared-types";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export interface NoteMoveDestination {
  readonly projectId: string | null;
  readonly folderId: string | null;
  readonly parentId: string | null;
  readonly beforeNoteId?: string | null;
}

function SortableNote({
  note,
  folderName,
  tagsById,
  controls,
  pending,
  destinations,
  onMove,
  previous,
  next,
  afterNext,
  parent,
  movementDisabled,
  relativeOrderingDisabled,
}: {
  readonly note: NoteSummary;
  readonly folderName?: string;
  readonly tagsById?: ReadonlyMap<string, TagSummary>;
  readonly controls: ReactNode;
  readonly pending: boolean;
  readonly destinations: readonly {
    readonly value: string;
    readonly label: string;
    readonly projectId: string | null;
    readonly folderId: string | null;
    readonly disabled?: boolean;
  }[];
  readonly onMove: (note: NoteSummary, destination: NoteMoveDestination) => void;
  readonly previous?: NoteSummary;
  readonly next?: NoteSummary;
  readonly afterNext?: NoteSummary;
  readonly parent?: NoteSummary;
  readonly movementDisabled: boolean;
  readonly relativeOrderingDisabled: boolean;
}) {
  const sortable = useSortable({
    id: note.id,
    disabled: pending || movementDisabled || relativeOrderingDisabled,
  });
  const [destinationValue, setDestinationValue] = useState(
    note.projectId === null
      ? note.folderId === null
        ? "standalone"
        : `folder:${note.folderId}`
      : `project:${note.projectId}`,
  );
  useEffect(() => {
    setDestinationValue(
      note.projectId === null
        ? note.folderId === null
          ? "standalone"
          : `folder:${note.folderId}`
        : `project:${note.projectId}`,
    );
  }, [note.folderId, note.projectId]);
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <li ref={sortable.setNodeRef} style={style} className="motion-reduce:!transition-none">
      <NoteCard
        note={note}
        folderName={folderName}
        tagsById={tagsById}
        controls={
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                ref={sortable.setActivatorNodeRef}
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending || movementDisabled || relativeOrderingDisabled}
                aria-label={`Drag ${note.title}`}
                {...sortable.attributes}
                {...sortable.listeners}
              >
                <GripVertical aria-hidden="true" className="size-4" />
                Drag
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  pending || movementDisabled || relativeOrderingDisabled || previous === undefined
                }
                onClick={() =>
                  previous !== undefined &&
                  onMove(note, {
                    projectId: note.projectId,
                    folderId: note.folderId,
                    parentId: note.parentId,
                    beforeNoteId: previous.id,
                  })
                }
              >
                <ArrowUp aria-hidden="true" className="size-4" />
                Move up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  pending || movementDisabled || relativeOrderingDisabled || next === undefined
                }
                onClick={() =>
                  onMove(note, {
                    projectId: note.projectId,
                    folderId: note.folderId,
                    parentId: note.parentId,
                    beforeNoteId: afterNext?.id ?? null,
                  })
                }
              >
                <ArrowDown aria-hidden="true" className="size-4" />
                Move down
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  pending || movementDisabled || relativeOrderingDisabled || previous === undefined
                }
                onClick={() =>
                  previous !== undefined &&
                  onMove(note, {
                    projectId: note.projectId,
                    folderId: note.folderId,
                    parentId: previous.id,
                    beforeNoteId: null,
                  })
                }
              >
                <ArrowRight aria-hidden="true" className="size-4" />
                Indent
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  pending || movementDisabled || relativeOrderingDisabled || parent === undefined
                }
                onClick={() =>
                  parent !== undefined &&
                  onMove(note, {
                    projectId: note.projectId,
                    folderId: note.folderId,
                    parentId: parent.parentId,
                    beforeNoteId: null,
                  })
                }
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                Outdent
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="sr-only" htmlFor={`destination-${note.id}`}>
                Destination for {note.title}
              </label>
              <select
                id={`destination-${note.id}`}
                className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
                disabled={pending || movementDisabled}
                value={destinationValue}
                onChange={(event) => setDestinationValue(event.target.value)}
              >
                {destinations.map((destination) => (
                  <option
                    key={destination.value}
                    value={destination.value}
                    disabled={destination.disabled}
                  >
                    {destination.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || movementDisabled}
                onClick={() => {
                  const destination = destinations.find((item) => item.value === destinationValue);
                  if (destination !== undefined && destination.disabled !== true)
                    onMove(note, {
                      projectId: destination.projectId,
                      folderId: destination.folderId,
                      parentId: null,
                      beforeNoteId: null,
                    });
                }}
              >
                Move to destination
              </Button>
            </div>
            {controls}
          </div>
        }
      />
    </li>
  );
}

export function NoteList({
  notes,
  folders,
  tagsById,
  pendingIds,
  controlsFor,
  onMove,
  projectIds = [],
  movementDisabled = false,
  relativeOrderingDisabled = false,
}: {
  readonly notes: readonly NoteSummary[];
  readonly folders: readonly FolderSummary[];
  readonly tagsById?: ReadonlyMap<string, TagSummary>;
  readonly pendingIds: ReadonlySet<string>;
  readonly controlsFor: (note: NoteSummary) => ReactNode;
  readonly onMove: (note: NoteSummary, destination: NoteMoveDestination) => void;
  readonly projectIds?: readonly string[];
  readonly movementDisabled?: boolean;
  readonly relativeOrderingDisabled?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const destinations = [
    { value: "standalone", label: "Standalone · Unfiled", projectId: null, folderId: null },
    ...folders.map((folder) => ({
      value: `folder:${folder.id}`,
      label: `Standalone folder · ${folder.name}`,
      projectId: null,
      folderId: folder.id,
    })),
    ...[
      ...new Set([
        ...projectIds,
        ...notes.flatMap((note) => (note.projectId === null ? [] : [note.projectId])),
      ]),
    ].map((projectId) => ({
      value: `project:${projectId}`,
      label: `Project · ${projectId.slice(0, 8)}`,
      projectId,
      folderId: null,
    })),
  ];

  function dragEnd(event: DragEndEvent): void {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null || activeId === overId) return;
    const note = notes.find((item) => item.id === activeId);
    const over = notes.find((item) => item.id === overId);
    if (note === undefined || over === undefined) return;
    const sameContainer =
      note.projectId === over.projectId &&
      note.folderId === over.folderId &&
      note.parentId === over.parentId;
    const sourceIndex = notes.findIndex((item) => item.id === note.id);
    const overIndex = notes.findIndex((item) => item.id === over.id);
    const destinationSiblings = notes.filter(
      (item) =>
        item.id !== note.id &&
        item.projectId === over.projectId &&
        item.folderId === over.folderId &&
        item.parentId === over.parentId,
    );
    const destinationOverIndex = destinationSiblings.findIndex((item) => item.id === over.id);
    const beforeNoteId =
      sameContainer && sourceIndex < overIndex
        ? (destinationSiblings[destinationOverIndex + 1]?.id ?? null)
        : over.id;
    onMove(note, {
      projectId: over.projectId,
      folderId: over.folderId,
      parentId: over.parentId,
      beforeNoteId,
    });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <SortableContext items={notes.map((note) => note.id)} strategy={verticalListSortingStrategy}>
        <ul className="grid gap-4 lg:grid-cols-2" aria-label="Notes">
          {notes.map((note) => {
            const siblings = notes.filter(
              (item) =>
                item.projectId === note.projectId &&
                item.folderId === note.folderId &&
                item.parentId === note.parentId,
            );
            const siblingIndex = siblings.findIndex((item) => item.id === note.id);
            return (
              <SortableNote
                key={note.id}
                note={note}
                folderName={note.folderId === null ? undefined : folderNames.get(note.folderId)}
                tagsById={tagsById}
                controls={controlsFor(note)}
                pending={pendingIds.has(note.id)}
                destinations={destinations}
                previous={siblingIndex > 0 ? siblings[siblingIndex - 1] : undefined}
                next={siblingIndex >= 0 ? siblings[siblingIndex + 1] : undefined}
                afterNext={siblingIndex >= 0 ? siblings[siblingIndex + 2] : undefined}
                parent={
                  note.parentId === null
                    ? undefined
                    : notes.find((item) => item.id === note.parentId)
                }
                onMove={onMove}
                movementDisabled={movementDisabled}
                relativeOrderingDisabled={relativeOrderingDisabled}
              />
            );
          })}
        </ul>
      </SortableContext>
      {relativeOrderingDisabled && !movementDisabled ? (
        <p className="mt-3 rounded-md bg-muted p-3 text-sm" role="note">
          Relative ordering is available only in the complete first-page sibling view sorted by note
          order. Destination moves remain available.
        </p>
      ) : null}
    </DndContext>
  );
}
