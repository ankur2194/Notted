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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TaskStatusManager } from "./TaskStatusManager";

import type { TaskMovement } from "./TaskRow";
import type { CustomTaskStatus, TaskStatus, TaskSummary } from "@notted/shared-types";
import type { UpdateTaskInput } from "@notted/shared-validators";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { taskQueryKeys } from "@/lib/notes/query-keys";
import { requestTaskStatuses } from "@/lib/tasks/requests";

/**
 * The built-in columns, in `task_status` enum order. They are always present:
 * `tasks.status` is not nullable, so every card has one of these even when it
 * also carries a custom column.
 */
const BUILT_IN_COLUMNS: readonly { readonly id: TaskStatus; readonly label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "canceled", label: "Canceled" },
];

/** Droppable ids have to be distinguishable from task ids. */
const COLUMN_PREFIX = "column:";

export interface BoardColumn {
  readonly id: string;
  readonly label: string;
  /** The built-in status this column *is*, or `null` for a custom column. */
  readonly builtIn: TaskStatus | null;
  readonly color: string | null;
  readonly tasks: readonly TaskSummary[];
}

/**
 * Which column a card sits in: `customStatusId ?? status`.
 *
 * A custom id the column list does not contain (a project column on a board
 * scoped elsewhere, or one deleted in another tab) falls back to the built-in
 * status rather than dropping the card off the board.
 */
function columnIdOf(task: TaskSummary, known: ReadonlySet<string>): string {
  return task.customStatusId !== null && known.has(task.customStatusId)
    ? task.customStatusId
    : task.status;
}

export function buildColumns(
  tasks: readonly TaskSummary[],
  statuses: readonly CustomTaskStatus[],
): readonly BoardColumn[] {
  /*
   * `BUILT_IN_COLUMNS` already covers the four enum values, so a `task_statuses`
   * row flagged `isBuiltIn` would render a second column with the same meaning.
   * No such row is seeded today; the filter keeps that true if one ever is.
   */
  const custom = statuses
    .filter((entry) => !entry.isBuiltIn)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  const known = new Set(custom.map((entry) => entry.id));
  const definitions: readonly Omit<BoardColumn, "tasks">[] = [
    ...BUILT_IN_COLUMNS.map((entry) => ({ ...entry, builtIn: entry.id, color: null })),
    ...custom.map((entry) => ({
      id: entry.id,
      label: entry.name,
      builtIn: null,
      color: entry.color,
    })),
  ];
  return definitions.map((definition) => ({
    ...definition,
    tasks: tasks.filter((task) => columnIdOf(task, known) === definition.id),
  }));
}

/** The single `updateTask` payload that moves a card into `column`. */
export function columnMovePayload(column: BoardColumn): UpdateTaskInput {
  // A built-in column also clears any custom column, so the card cannot show one
  // label and behave as another. A custom column leaves `status` alone, which is
  // what keeps `completed_at` driven by the built-in column exactly as before.
  return column.builtIn === null
    ? { customStatusId: column.id }
    : { status: column.builtIn, customStatusId: null };
}

function SortableCard({
  task,
  index,
  total,
  dragDisabled,
  onMove,
  render,
  children,
}: {
  readonly task: TaskSummary;
  readonly index: number;
  readonly total: number;
  readonly dragDisabled: boolean;
  readonly onMove: (task: TaskSummary, position: number) => void;
  readonly render: (task: TaskSummary, movement: TaskMovement) => ReactNode;
  readonly children: ReactNode;
}) {
  const sortable = useSortable({ id: task.id, disabled: dragDisabled });
  return (
    <li
      ref={sortable.setNodeRef}
      className="motion-reduce:!transition-none"
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      {render(task, {
        index,
        total,
        dragDisabled,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
        attributes: sortable.attributes,
        listeners: sortable.listeners,
        onMove: (position) => onMove(task, position),
      })}
      {children}
    </li>
  );
}

/**
 * The keyboard route between columns (WCAG 2.5.7). It is a plain select plus a
 * button rather than a drag alternative bolted onto the handle, so it works
 * identically for pointer, keyboard and speech users.
 */
function ColumnMover({
  task,
  columns,
  currentColumnId,
  disabled,
  onMove,
}: {
  readonly task: TaskSummary;
  readonly columns: readonly BoardColumn[];
  readonly currentColumnId: string;
  readonly disabled: boolean;
  readonly onMove: (task: TaskSummary, columnId: string) => void;
}) {
  const [target, setTarget] = useState(currentColumnId);
  const selectId = `task-${task.id}-column`;
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor={selectId}>
          Column for {task.title}
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
        onClick={() => onMove(task, target)}
      >
        Move to column
        <span className="sr-only"> for {task.title}</span>
      </Button>
    </div>
  );
}

function ColumnList({
  column,
  headingId,
  children,
}: {
  readonly column: BoardColumn;
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
 * The Kanban partition of the *same* task page the list view renders.
 *
 * The board issues no task request of its own: it receives the rows the
 * container already holds under one `taskQueryKeys.list` entry, so every
 * optimistic mutation, rollback and reconcile written for the list keeps all
 * three views consistent for free.
 *
 * ponytail: single 100-row page, per-column pagination if boards get large.
 */
export function TaskBoard({
  workspaceId,
  projectId,
  tasks,
  canEdit,
  canManageColumns,
  hasMore,
  orderable,
  operationPending,
  onUpdate,
  onReorder,
  renderTask,
}: {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly tasks: readonly TaskSummary[];
  readonly canEdit: boolean;
  /** Owner and admin only: the three status mutations need `settings.update`. */
  readonly canManageColumns: boolean;
  /** True when the shared page is truncated, so the board is not the whole set. */
  readonly hasMore: boolean;
  /** The list view's reorder guard: a complete first page sorted by task order. */
  readonly orderable: boolean;
  readonly operationPending: boolean;
  readonly onUpdate: (task: TaskSummary, input: UpdateTaskInput) => void;
  readonly onReorder: (
    task: TaskSummary,
    beforeTaskId: string | null,
    position: number,
    total: number,
  ) => void;
  readonly renderTask: (task: TaskSummary, movement: TaskMovement) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const statusesQuery = useQuery({
    queryKey: taskQueryKeys.statuses(workspaceId, projectId),
    queryFn: async () => {
      const result = await requestTaskStatuses(
        workspaceId,
        projectId === null ? {} : { projectId },
      );
      if (!result.ok) throw new Error(result.kind);
      return result.data.items;
    },
    retry: false,
  });

  const statuses = statusesQuery.data ?? [];
  const columns = buildColumns(tasks, statuses);
  const columnOf = new Map(
    columns.flatMap((column) => column.tasks.map((task) => [task.id, column.id] as const)),
  );
  const dragDisabled = !canEdit || operationPending || !orderable;
  const reorderUnavailable = !canEdit
    ? null
    : orderable
      ? null
      : "Reordering is available only in the complete first page of tasks sorted by task order. Moving a card between columns still works.";

  function moveToColumn(task: TaskSummary, columnId: string): void {
    const column = columns.find((entry) => entry.id === columnId);
    if (column === undefined || columnOf.get(task.id) === columnId) return;
    onUpdate(task, columnMovePayload(column));
  }

  /** Anchor-based reorder inside one column: `null` appends to that column. */
  function moveWithinColumn(task: TaskSummary, position: number): void {
    const column = columns.find((entry) => entry.id === columnOf.get(task.id));
    if (column === undefined || !orderable) return;
    const others = column.tasks.filter((entry) => entry.id !== task.id);
    onReorder(task, others[position - 1]?.id ?? null, position, column.tasks.length);
  }

  function dragEnd(event: DragEndEvent): void {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null || activeId === overId) return;
    const task = tasks.find((entry) => entry.id === activeId);
    const source = columnOf.get(activeId);
    if (task === undefined || source === undefined) return;
    const target = overId.startsWith(COLUMN_PREFIX)
      ? overId.slice(COLUMN_PREFIX.length)
      : columnOf.get(overId);
    if (target === undefined) return;
    if (target !== source) {
      // One request, one rollback path: a cross-column drop sets the column and
      // deliberately does not also reorder.
      moveToColumn(task, target);
      return;
    }
    const column = columns.find((entry) => entry.id === source);
    if (column === undefined) return;
    const others = column.tasks.filter((entry) => entry.id !== activeId);
    if (overId.startsWith(COLUMN_PREFIX)) {
      moveWithinColumn(task, others.length + 1);
      return;
    }
    // Dropping below the target lands after it, dropping above lands on it —
    // the same asymmetry `TaskSortableList` handles.
    const sourceIndex = column.tasks.findIndex((entry) => entry.id === activeId);
    const overIndex = column.tasks.findIndex((entry) => entry.id === overId);
    const overInOthers = others.findIndex((entry) => entry.id === overId);
    if (sourceIndex === -1 || overIndex === -1 || overInOthers === -1) return;
    moveWithinColumn(task, sourceIndex < overIndex ? overInOthers + 2 : overInOthers + 1);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {columns.length} columns · {tasks.length} cards
        </p>
        {canManageColumns ? (
          <TaskStatusManager
            workspaceId={workspaceId}
            projectId={projectId}
            statuses={statuses}
            isLoading={statusesQuery.isPending}
            isError={statusesQuery.isError}
            cardCounts={
              new Map(
                columns
                  .filter((column) => column.builtIn === null)
                  .map((column) => [column.id, column.tasks.length] as const),
              )
            }
            onRetry={() => void statusesQuery.refetch()}
            onChanged={() => {
              // One invalidate, not two: the column list is keyed under the same
              // `all` prefix as the rows, and a rename also changes the
              // `statusLabel` carried on every card in the shared cache entry.
              void queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(workspaceId) });
            }}
          />
        ) : null}
      </div>

      {statusesQuery.isError ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          The custom columns could not be loaded, so only the four built-in columns are shown. No
          card was moved or hidden — a card with a custom column appears under its built-in status
          until the list loads.
        </p>
      ) : null}

      {hasMore ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          This board shows the first {tasks.length} tasks only and is truncated. No omitted task was
          changed or hidden from its column on the server.
        </p>
      ) : null}

      <DndContext
        id="task-board-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={dragEnd}
      >
        {/* A row of columns that scrolls sideways rather than squeezing: a
            column narrower than a card is not a board.

            `tabIndex`/`role`/`aria-label`: WCAG 2.2 SC 2.1.1. A horizontally
            scrolling container that holds no focusable descendant — which is
            exactly what an empty board is — can be reached by a pointer and by
            nothing else. axe's `scrollable-region-focusable` rule failed this
            element on the Part 76 board scan. Making it a named region that
            takes focus gives the keyboard the arrow keys the mouse already
            has. */}
        <div
          className="flex gap-4 overflow-x-auto pb-2"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region is the documented exception to this rule: axe's `scrollable-region-focusable` requires exactly this, and the rule's own allowlist covers only `tabpanel`.
          tabIndex={0}
          role="region"
          aria-label="Task board columns"
        >
          {columns.map((column) => {
            const headingId = `task-board-column-${column.id}`;
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
                  {column.label} ({column.tasks.length})
                </h3>
                <SortableContext
                  items={column.tasks.map((task) => task.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ColumnList column={column} headingId={headingId}>
                    {column.tasks.length === 0 ? (
                      <li className="p-2 text-sm text-muted-foreground">
                        No tasks in this column.
                      </li>
                    ) : (
                      column.tasks.map((task, index) => (
                        <SortableCard
                          key={task.id}
                          task={task}
                          index={index}
                          total={column.tasks.length}
                          dragDisabled={dragDisabled}
                          onMove={(target, position) => moveWithinColumn(target, position)}
                          render={renderTask}
                        >
                          <ColumnMover
                            // Remounts when the card lands elsewhere, so the
                            // selector can never keep offering a stale column.
                            key={column.id}
                            task={task}
                            columns={columns}
                            currentColumnId={column.id}
                            disabled={!canEdit || operationPending}
                            onMove={moveToColumn}
                          />
                        </SortableCard>
                      ))
                    )}
                  </ColumnList>
                </SortableContext>
              </section>
            );
          })}
        </div>
        {reorderUnavailable === null ? null : (
          <p className="mt-3 rounded-md bg-muted p-3 text-sm" role="note">
            {reorderUnavailable}
          </p>
        )}
      </DndContext>
    </div>
  );
}
