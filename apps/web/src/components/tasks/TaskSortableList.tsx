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

import type { TaskMovement } from "./TaskRow";
import type { TaskGroup } from "@/lib/tasks/grouping";
import type { TaskSummary } from "@notted/shared-types";
import type { ReactNode } from "react";

/**
 * Resolves a 1-based destination position into the `beforeTaskId` anchor the
 * reorder contract takes.
 *
 * The moving task is removed from the projection first, so position `n` always
 * means "the nth row of the list you will see afterwards". Position
 * `flat.length` has no successor and correctly yields `null`, which appends.
 */
export function anchorForPosition(
  flat: readonly TaskSummary[],
  taskId: string,
  position: number,
): string | null {
  const others = flat.filter((task) => task.id !== taskId);
  return others[position - 1]?.id ?? null;
}

function SortableTask({
  task,
  index,
  total,
  dragDisabled,
  onMove,
  render,
}: {
  readonly task: TaskSummary;
  readonly index: number;
  readonly total: number;
  readonly dragDisabled: boolean;
  readonly onMove: (task: TaskSummary, position: number) => void;
  readonly render: (task: TaskSummary, movement: TaskMovement) => ReactNode;
}) {
  const sortable = useSortable({ id: task.id, disabled: dragDisabled });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <li ref={sortable.setNodeRef} style={style} className="motion-reduce:!transition-none">
      {render(task, {
        index,
        total,
        dragDisabled,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
        attributes: sortable.attributes,
        listeners: sortable.listeners,
        onMove: (position) => onMove(task, position),
      })}
    </li>
  );
}

/**
 * The ordered task list: one `DndContext` over every rendered group.
 *
 * Drag is a single flat projection even when the rows are shown in groups,
 * which is exactly why the caller disables it while grouped — a drop would
 * otherwise compute its anchor against a partial view of the order.
 */
export function TaskSortableList({
  groups,
  dragDisabled,
  dragDisabledReason,
  idPrefix,
  onReorder,
  renderTask,
}: {
  readonly groups: readonly TaskGroup[];
  readonly dragDisabled: boolean;
  /** Shown as a `role="note"` explanation whenever drag is unavailable. */
  readonly dragDisabledReason: string | null;
  readonly idPrefix: string;
  readonly onReorder: (task: TaskSummary, beforeTaskId: string | null, position: number) => void;
  readonly renderTask: (task: TaskSummary, movement: TaskMovement) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const flat = groups.flatMap((group) => group.tasks);

  function move(task: TaskSummary, position: number): void {
    onReorder(task, anchorForPosition(flat, task.id, position), position);
  }

  function dragEnd(event: DragEndEvent): void {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null || activeId === overId) return;
    const task = flat.find((item) => item.id === activeId);
    const sourceIndex = flat.findIndex((item) => item.id === activeId);
    const overIndex = flat.findIndex((item) => item.id === overId);
    if (task === undefined || sourceIndex === -1 || overIndex === -1) return;
    // Dropping below the target lands after it, dropping above lands on it —
    // the same asymmetry `NoteList` handles, expressed as a position so the
    // anchor and the announcement stay derived from one number.
    const others = flat.filter((item) => item.id !== activeId);
    const overInOthers = others.findIndex((item) => item.id === overId);
    move(task, sourceIndex < overIndex ? overInOthers + 2 : overInOthers + 1);
  }

  return (
    // The explicit `id` is required, not decorative. Without it dnd-kit derives
    // its `DndDescribedBy-*` ids from `useId`, whose counter depends on how many
    // hooks ran before it — and this list renders a loading branch on the server
    // and a populated branch on the client. The counters then disagree and React
    // logs a hydration mismatch on every task page. `idPrefix` is already unique
    // per mounted list, so it is the stable name dnd-kit needs.
    <DndContext
      id={`${idPrefix}-dnd`}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={dragEnd}
    >
      <SortableContext items={flat.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-6">
          {groups.map((group) => {
            const headingId = `${idPrefix}-group-${group.key}`;
            return (
              <section key={group.key}>
                <h3 id={headingId} className="text-sm font-semibold">
                  {group.label} ({group.tasks.length})
                </h3>
                <ul aria-labelledby={headingId} className="mt-2 grid gap-3">
                  {group.tasks.map((task) => (
                    <SortableTask
                      key={task.id}
                      task={task}
                      index={flat.findIndex((item) => item.id === task.id)}
                      total={flat.length}
                      dragDisabled={dragDisabled}
                      onMove={move}
                      render={renderTask}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </SortableContext>
      {dragDisabled && dragDisabledReason !== null ? (
        <p className="mt-3 rounded-md bg-muted p-3 text-sm" role="note">
          {dragDisabledReason}
        </p>
      ) : null}
    </DndContext>
  );
}
