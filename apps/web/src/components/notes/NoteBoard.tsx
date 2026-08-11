"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
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
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useState } from "react";

import { NoteCard } from "./NoteCard";

import type { NoteViewProps } from "./note-view";
import type { CustomTaskStatus, NoteSummary, TagSummary } from "@notted/shared-types";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * The leading bucket. Not a column id: a note lands here when it has no column
 * at all, and equally when it names a column this board does not know about.
 */
const NO_COLUMN = "no-column";

/** Droppable ids have to be distinguishable from note ids. */
const COLUMN_PREFIX = "column:";

export interface NoteBoardColumn {
  readonly id: string;
  readonly label: string;
  readonly color: string | null;
  readonly notes: readonly NoteSummary[];
}

/**
 * Which bucket a card sits in.
 *
 * A `boardColumnId` the column list does not contain (a column deleted in
 * another tab, or one belonging to a different project) falls back to
 * "No column" rather than dropping the card off the board — the same rule
 * `TaskBoard.columnIdOf` applies.
 */
export function noteColumnIdOf(note: NoteSummary, known: ReadonlySet<string>): string {
  return note.boardColumnId !== null && known.has(note.boardColumnId)
    ? note.boardColumnId
    : NO_COLUMN;
}

export function buildNoteColumns(
  notes: readonly NoteSummary[],
  statuses: readonly CustomTaskStatus[],
): readonly NoteBoardColumn[] {
  const sorted = [...statuses].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
  );
  const known = new Set(sorted.map((entry) => entry.id));
  const definitions: readonly Omit<NoteBoardColumn, "notes">[] = [
    { id: NO_COLUMN, label: "No column", color: null },
    ...sorted.map((entry) => ({ id: entry.id, label: entry.name, color: entry.color })),
  ];
  return definitions.map((definition) => ({
    ...definition,
    notes: notes.filter((note) => noteColumnIdOf(note, known) === definition.id),
  }));
}

/** The board's `boardColumnId` for a bucket: the sentinel means "clear it". */
function columnValue(columnId: string): string | null {
  return columnId === NO_COLUMN ? null : columnId;
}

/**
 * The keyboard route between columns (WCAG 2.5.7). A plain select plus a button
 * rather than an alternative bolted onto the drag handle, so it works
 * identically for pointer, keyboard and speech users.
 */
function ColumnMover({
  note,
  columns,
  currentColumnId,
  disabled,
  onMove,
}: {
  readonly note: NoteSummary;
  readonly columns: readonly NoteBoardColumn[];
  readonly currentColumnId: string;
  readonly disabled: boolean;
  readonly onMove: (note: NoteSummary, columnId: string) => void;
}) {
  const [target, setTarget] = useState(currentColumnId);
  const selectId = `note-${note.id}-column`;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor={selectId}>
          Column for {note.title}
        </label>
        <select
          id={selectId}
          className="min-h-11 rounded-md border bg-background px-3 text-sm"
          value={target}
          disabled={disabled}
          onChange={(event) => setTarget(event.target.value)}
        >
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.label}
            </option>
          ))}
        </select>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11"
        disabled={disabled || target === currentColumnId}
        onClick={() => onMove(note, target)}
      >
        Move to column
        <span className="sr-only"> for {note.title}</span>
      </Button>
    </div>
  );
}

function SortableNoteCard({
  note,
  column,
  columns,
  index,
  tagsById,
  controls,
  dragDisabled,
  columnMoveDisabled,
  onReorder,
  onColumnMove,
}: {
  readonly note: NoteSummary;
  readonly column: NoteBoardColumn;
  readonly columns: readonly NoteBoardColumn[];
  readonly index: number;
  readonly tagsById?: ReadonlyMap<string, TagSummary>;
  readonly controls: ReactNode;
  readonly dragDisabled: boolean;
  readonly columnMoveDisabled: boolean;
  readonly onReorder: (note: NoteSummary, position: number) => void;
  readonly onColumnMove: (note: NoteSummary, columnId: string) => void;
}) {
  const sortable = useSortable({ id: note.id, disabled: dragDisabled });
  const total = column.notes.length;
  return (
    <li
      ref={sortable.setNodeRef}
      className="motion-reduce:!transition-none"
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <NoteCard
        note={note}
        tagsById={tagsById}
        controls={
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                ref={sortable.setActivatorNodeRef}
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11"
                disabled={dragDisabled}
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
                className="min-h-11"
                disabled={dragDisabled || index === 0}
                onClick={() => onReorder(note, index)}
              >
                <ArrowUp aria-hidden="true" className="size-4" />
                Move up
                <span className="sr-only"> {note.title}</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={dragDisabled || index >= total - 1}
                onClick={() => onReorder(note, index + 2)}
              >
                <ArrowDown aria-hidden="true" className="size-4" />
                Move down
                <span className="sr-only"> {note.title}</span>
              </Button>
            </div>
            <ColumnMover
              // Remounts when the card lands elsewhere, so the selector can
              // never keep offering a stale column.
              key={column.id}
              note={note}
              columns={columns}
              currentColumnId={column.id}
              disabled={columnMoveDisabled}
              onMove={onColumnMove}
            />
            {controls}
          </div>
        }
      />
    </li>
  );
}

function ColumnList({
  column,
  headingId,
  children,
}: {
  readonly column: NoteBoardColumn;
  readonly headingId: string;
  readonly children: ReactNode;
}) {
  // The column itself is a drop target, so an empty column and the space below
  // the last card still accept a card dragged from elsewhere.
  const droppable = useDroppable({ id: `${COLUMN_PREFIX}${column.id}` });
  return (
    <ul
      ref={droppable.setNodeRef}
      aria-labelledby={headingId}
      className="mt-2 grid min-h-24 gap-3 rounded-md bg-muted/30 p-2"
    >
      {children}
    </ul>
  );
}

/**
 * The Kanban partition of the *same* note page the list view renders.
 *
 * The board issues no note request and no column request of its own: it
 * receives the rows the container already holds under one `noteQueryKeys.list`
 * entry and the columns under one `taskQueryKeys.statuses` entry, so every
 * optimistic move, rollback and reconcile written for the list keeps all four
 * views consistent for free.
 *
 * ponytail: single 50-row page, per-column pagination if project boards get large.
 */
export function NoteBoard({
  notes,
  columns: statuses,
  canEdit,
  pendingIds,
  onMove,
  controlsFor,
  tagsById,
  hasMore,
  orderingDisabled,
  columnsLoading = false,
  columnsUnavailable = false,
}: NoteViewProps & {
  readonly controlsFor: (note: NoteSummary) => ReactNode;
  readonly tagsById?: ReadonlyMap<string, TagSummary>;
  /** True when the shared page is truncated, so the board is not the whole set. */
  readonly hasMore: boolean;
  /** The list view's reorder guard: a complete first page sorted by note order. */
  readonly orderingDisabled: boolean;
  readonly columnsLoading?: boolean;
  readonly columnsUnavailable?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const columns = buildNoteColumns(notes, statuses);
  const columnOf = new Map(
    columns.flatMap((column) => column.notes.map((note) => [note.id, column.id] as const)),
  );
  const operationPending = pendingIds.size > 0;
  const columnMoveDisabled = !canEdit || operationPending;
  const dragDisabled = columnMoveDisabled || orderingDisabled || hasMore;

  /** One request: the column changes, placement appends inside the target. */
  function moveToColumn(note: NoteSummary, columnId: string): void {
    if (columnOf.get(note.id) === columnId || !columns.some((entry) => entry.id === columnId))
      return;
    onMove(note, {
      projectId: note.projectId,
      folderId: note.folderId,
      parentId: note.parentId,
      boardColumnId: columnValue(columnId),
      beforeNoteId: null,
    });
  }

  /**
   * Anchor-based reorder inside one column: `null` appends. `boardColumnId` is
   * deliberately omitted — omitted means keep, so a reorder cannot clear a
   * column as a side effect.
   */
  function moveWithinColumn(note: NoteSummary, position: number): void {
    const column = columns.find((entry) => entry.id === columnOf.get(note.id));
    if (column === undefined || dragDisabled) return;
    const others = column.notes.filter((entry) => entry.id !== note.id);
    onMove(note, {
      projectId: note.projectId,
      folderId: note.folderId,
      parentId: note.parentId,
      beforeNoteId: others[position - 1]?.id ?? null,
    });
  }

  function dragEnd(event: DragEndEvent): void {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null || activeId === overId) return;
    const note = notes.find((entry) => entry.id === activeId);
    const source = columnOf.get(activeId);
    if (note === undefined || source === undefined) return;
    const target = overId.startsWith(COLUMN_PREFIX)
      ? overId.slice(COLUMN_PREFIX.length)
      : columnOf.get(overId);
    if (target === undefined) return;
    if (target !== source) {
      moveToColumn(note, target);
      return;
    }
    const column = columns.find((entry) => entry.id === source);
    if (column === undefined) return;
    const others = column.notes.filter((entry) => entry.id !== activeId);
    if (overId.startsWith(COLUMN_PREFIX)) {
      moveWithinColumn(note, others.length + 1);
      return;
    }
    // Dropping below the target lands after it, dropping above lands on it —
    // the same asymmetry `NoteList` handles.
    const sourceIndex = column.notes.findIndex((entry) => entry.id === activeId);
    const overIndex = column.notes.findIndex((entry) => entry.id === overId);
    const overInOthers = others.findIndex((entry) => entry.id === overId);
    if (sourceIndex === -1 || overIndex === -1 || overInOthers === -1) return;
    moveWithinColumn(note, sourceIndex < overIndex ? overInOthers + 2 : overInOthers + 1);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {columns.length} columns · {notes.length} cards
        {columnsLoading ? " · Loading board columns…" : ""}
      </p>

      {canEdit ? null : (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          Your role can read this board but cannot move notes between columns. Backend authorization
          remains authoritative.
        </p>
      )}

      {columnsUnavailable ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          The board columns could not be loaded, so only “No column” is shown. No card was moved or
          hidden — every note keeps the column it already had on the server.
        </p>
      ) : null}

      {hasMore ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          This board shows the first {notes.length} notes only and is truncated. No omitted note was
          changed or hidden from its column on the server.
        </p>
      ) : null}

      <DndContext
        id="note-board-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={dragEnd}
      >
        {/* A row of columns that scrolls sideways rather than squeezing: a
            column narrower than a card is not a board. */}
        <div className="flex gap-4 overflow-x-auto pb-2">
          {columns.map((column) => {
            const headingId = `note-board-column-${column.id}`;
            return (
              <section key={column.id} className="min-w-72 flex-1">
                <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
                  {column.color === null ? null : (
                    <span
                      aria-hidden="true"
                      style={{ backgroundColor: column.color }}
                      className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                    />
                  )}
                  {column.label} ({column.notes.length})
                </h3>
                <SortableContext
                  items={column.notes.map((note) => note.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ColumnList column={column} headingId={headingId}>
                    {column.notes.length === 0 ? (
                      <li className="p-2 text-sm text-muted-foreground">
                        No notes in this column.
                      </li>
                    ) : (
                      column.notes.map((note, index) => (
                        <SortableNoteCard
                          key={note.id}
                          note={note}
                          column={column}
                          columns={columns}
                          index={index}
                          tagsById={tagsById}
                          controls={controlsFor(note)}
                          dragDisabled={dragDisabled || pendingIds.has(note.id)}
                          columnMoveDisabled={columnMoveDisabled}
                          onReorder={moveWithinColumn}
                          onColumnMove={moveToColumn}
                        />
                      ))
                    )}
                  </ColumnList>
                </SortableContext>
              </section>
            );
          })}
        </div>
        {canEdit && (orderingDisabled || hasMore) ? (
          <p className="mt-3 rounded-md bg-muted p-3 text-sm" role="note">
            Reordering inside a column is available only in the complete first page of notes sorted
            by note order. Moving a card between columns still works.
          </p>
        ) : null}
      </DndContext>
    </div>
  );
}
