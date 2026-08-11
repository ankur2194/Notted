"use client";

import { ArrowDown, ArrowUp, GripVertical, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type {
  TagSummary,
  TaskPriority,
  TaskRecurrence,
  TaskSummary,
  WorkspaceMemberSummary,
} from "@notted/shared-types";
import type { UpdateTaskInput } from "@notted/shared-validators";

import { TagPicker } from "@/components/tags/TagPicker";
import { Button } from "@/components/ui/button";
import {
  composeDueDate,
  dueLabel,
  isOverdue,
  splitDueDate,
  viewerTimeZone,
} from "@/lib/tasks/grouping";

/**
 * Everything a row needs to move itself, supplied by `TaskSortableList`.
 *
 * `onMove` takes a 1-based destination position rather than an anchor id: the
 * list owns the flat projection, so it — not the row — is the only place that
 * can turn a position into the correct `beforeTaskId`.
 */
export interface TaskMovement {
  /** 0-based position in the flat list. */
  readonly index: number;
  readonly total: number;
  readonly dragDisabled: boolean;
  readonly setActivatorNodeRef: (node: HTMLElement | null) => void;
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
  readonly onMove: (position: number) => void;
}

const PRIORITIES: readonly { readonly value: TaskPriority; readonly label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const RECURRENCES: readonly { readonly value: TaskRecurrence; readonly label: string }[] = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom (cron)" },
];

const STATUS_LABELS: Readonly<Record<TaskSummary["status"], string>> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};

function priorityLabel(priority: TaskPriority): string {
  return PRIORITIES.find((entry) => entry.value === priority)?.label ?? priority;
}

export function TaskRow({
  task,
  members,
  tags,
  now,
  pending,
  disabled,
  canDelete = true,
  canUnassign = true,
  selected,
  onSelectedChange,
  onUpdate,
  onDelete,
  movement,
}: {
  readonly task: TaskSummary;
  readonly members: readonly WorkspaceMemberSummary[];
  readonly tags: readonly TagSummary[];
  readonly now: Date;
  readonly pending: boolean;
  /** True when the viewer may read but not change tasks. */
  readonly disabled: boolean;
  /**
   * False hides the delete control outright rather than disabling it: an editor
   * is denied `task.delete` on every row, so the button could never succeed.
   * Defaults to the permissive value — the backend policy stays authoritative
   * and this only stops offering doomed affordances.
   */
  readonly canDelete?: boolean;
  /**
   * False drops the "Unassigned" option once the task has an assignee. The
   * editor branch of `task.assign` requires an active target, so clearing an
   * assignee is always refused for them.
   */
  readonly canUnassign?: boolean;
  readonly selected: boolean;
  readonly onSelectedChange: (next: boolean) => void;
  readonly onUpdate: (task: TaskSummary, input: UpdateTaskInput) => void;
  readonly onDelete: (task: TaskSummary) => void;
  readonly movement: TaskMovement;
}) {
  const locked = disabled || pending;
  const stored = splitDueDate(task.dueDate);
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState(stored.date);
  const [time, setTime] = useState(stored.time);
  const [recurrence, setRecurrence] = useState<TaskRecurrence>(task.recurrence);
  const [cron, setCron] = useState(task.recurrenceCron ?? "");
  const [position, setPosition] = useState(String(movement.index + 1));

  // The server row is authoritative: a rollback, a reconcile, or another
  // writer's change has to replace whatever is sitting in these inputs,
  // otherwise the row keeps displaying an edit that was never saved.
  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);
  useEffect(() => {
    const next = splitDueDate(task.dueDate);
    setDate(next.date);
    setTime(next.time);
  }, [task.dueDate]);
  useEffect(() => {
    setRecurrence(task.recurrence);
    setCron(task.recurrenceCron ?? "");
  }, [task.recurrence, task.recurrenceCron]);
  useEffect(() => {
    setPosition(String(movement.index + 1));
  }, [movement.index]);

  const overdue = isOverdue(task, now);
  const due = dueLabel(task, now);
  const complete = task.completedAt !== null || task.status === "done";
  const statusText = task.statusLabel ?? STATUS_LABELS[task.status];
  const idPrefix = `task-${task.id}`;

  function commitTitle(): void {
    const next = title.trim();
    if (next.length === 0) {
      setTitle(task.title);
      return;
    }
    if (next === task.title) return;
    onUpdate(task, { title: next });
  }

  function commitDue(nextDate: string, nextTime: string): void {
    setDate(nextDate);
    setTime(nextTime);
    // A cleared date drops the time with it: a time alone has no instant to
    // attach to, and sending one would be a silent guess about which day.
    if (nextDate === "") {
      setTime("");
      if (task.dueDate !== null) onUpdate(task, { dueDate: null });
      return;
    }
    const composed = composeDueDate(nextDate, nextTime);
    if (composed !== null && composed !== task.dueDate) onUpdate(task, { dueDate: composed });
  }

  function commitRecurrence(next: TaskRecurrence): void {
    setRecurrence(next);
    // Switching away from `custom` clears the cron in the same request: the
    // contract rejects a stale expression on a non-custom recurrence, and
    // keeping one would resurface it on the next unrelated edit.
    if (next !== "custom") {
      setCron("");
      onUpdate(task, { recurrence: next, recurrenceCron: null });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor={`${idPrefix}-select`}>
          <input
            id={`${idPrefix}-select`}
            type="checkbox"
            className="size-4"
            checked={selected}
            disabled={disabled}
            onChange={(event) => onSelectedChange(event.target.checked)}
          />
          <span className="sr-only">Select {task.title}</span>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor={`${idPrefix}-done`}>
          <input
            id={`${idPrefix}-done`}
            type="checkbox"
            className="size-4"
            checked={complete}
            disabled={locked}
            onChange={(event) => onUpdate(task, { status: event.target.checked ? "done" : "todo" })}
          />
          <span className="sr-only">Complete {task.title}</span>
        </label>
        <div className="min-w-48 flex-1">
          <label className="sr-only" htmlFor={`${idPrefix}-title`}>
            Title for {task.title}
          </label>
          <input
            id={`${idPrefix}-title`}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={title}
            maxLength={500}
            disabled={locked}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTitle();
              }
              if (event.key === "Escape") setTitle(task.title);
            }}
          />
        </div>
        {canDelete ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => onDelete(task)}
          >
            <Trash2 aria-hidden="true" className="size-4" />
            Delete
            <span className="sr-only"> {task.title}</span>
          </Button>
        ) : null}
      </div>

      {/*
       * Status, overdue and priority are stated as words. Colour alone would
       * carry none of this to a screen reader and none of it at all to a viewer
       * who cannot distinguish the hues (WCAG 1.4.1).
       */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Status: {statusText}</span>
        <span>Priority: {priorityLabel(task.priority)}</span>
        {due === null ? <span>No due date</span> : <span>Due {due}</span>}
        {overdue ? (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
            Overdue
          </span>
        ) : null}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${idPrefix}-date`}>
            Due date for {task.title}
          </label>
          <input
            id={`${idPrefix}-date`}
            type="date"
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={date}
            disabled={locked}
            onChange={(event) => commitDue(event.target.value, time)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${idPrefix}-time`}>
            Due time for {task.title}
          </label>
          <input
            id={`${idPrefix}-time`}
            type="time"
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={time}
            disabled={locked || date === ""}
            onChange={(event) => commitDue(date, event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave the time empty for midnight in your time zone ({viewerTimeZone()}).
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${idPrefix}-assignee`}>
            Assignee for {task.title}
          </label>
          <select
            id={`${idPrefix}-assignee`}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={task.assigneeId ?? ""}
            disabled={locked}
            onChange={(event) =>
              onUpdate(task, {
                assigneeId: event.target.value === "" ? null : event.target.value,
              })
            }
          >
            {canUnassign || task.assigneeId === null ? <option value="">Unassigned</option> : null}
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${idPrefix}-priority`}>
            Priority for {task.title}
          </label>
          <select
            id={`${idPrefix}-priority`}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={task.priority}
            disabled={locked}
            onChange={(event) => onUpdate(task, { priority: event.target.value as TaskPriority })}
          >
            {PRIORITIES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor={`${idPrefix}-recurrence`}>
          Recurrence for {task.title}
        </label>
        <select
          id={`${idPrefix}-recurrence`}
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm sm:max-w-xs"
          value={recurrence}
          disabled={locked}
          onChange={(event) => commitRecurrence(event.target.value as TaskRecurrence)}
        >
          {RECURRENCES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        {recurrence === "custom" ? (
          <div className="space-y-1 pt-2">
            <label className="text-xs font-medium" htmlFor={`${idPrefix}-cron`}>
              Recurrence cron for {task.title}
            </label>
            <input
              id={`${idPrefix}-cron`}
              className="min-h-11 w-full rounded-md border bg-background px-3 text-sm sm:max-w-xs"
              value={cron}
              maxLength={200}
              disabled={locked}
              aria-describedby={`${idPrefix}-cron-help`}
              onChange={(event) => setCron(event.target.value)}
            />
            {/*
             * Cron fields are UTC, unlike every due date on this page. Saying so
             * in visible help text is the whole point: an unstated assumption
             * here is the difference between a 09:00 reminder and a 04:00 one.
             */}
            <p id={`${idPrefix}-cron-help`} className="text-xs text-muted-foreground">
              Five cron fields, interpreted in UTC — not your local time zone ({viewerTimeZone()}).
              Example: <code>0 9 * * 1</code> is 09:00 UTC every Monday.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked || cron.trim().length === 0}
              onClick={() => onUpdate(task, { recurrence: "custom", recurrenceCron: cron.trim() })}
            >
              Save recurrence
              <span className="sr-only"> {task.title}</span>
            </Button>
          </div>
        ) : null}
      </div>

      <details>
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Tags ({task.tagIds.length})
        </summary>
        <div className="pt-2">
          <TagPicker
            tags={tags}
            value={task.tagIds}
            onChange={(next) => onUpdate(task, { tagIds: [...next] })}
            disabled={locked}
            legend={`Tags for ${task.title}`}
            idPrefix={idPrefix}
          />
        </div>
      </details>

      {/*
       * Every drag has a keyboard equivalent (WCAG 2.5.7): the two nudge
       * buttons and the absolute-position selector below reach any destination
       * the pointer can, and the visible label is a prefix of each accessible
       * name so speech control still works (WCAG 2.5.3).
       */}
      <div className="flex flex-wrap items-end gap-2">
        <Button
          ref={movement.setActivatorNodeRef}
          type="button"
          size="sm"
          variant="ghost"
          disabled={locked || movement.dragDisabled}
          aria-label={`Reorder ${task.title}`}
          {...movement.attributes}
          {...movement.listeners}
        >
          <GripVertical aria-hidden="true" className="size-4" />
          Reorder
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked || movement.dragDisabled || movement.index === 0}
          onClick={() => movement.onMove(movement.index)}
        >
          <ArrowUp aria-hidden="true" className="size-4" />
          Move up
          <span className="sr-only"> {task.title}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked || movement.dragDisabled || movement.index >= movement.total - 1}
          onClick={() => movement.onMove(movement.index + 2)}
        >
          <ArrowDown aria-hidden="true" className="size-4" />
          Move down
          <span className="sr-only"> {task.title}</span>
        </Button>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${idPrefix}-position`}>
            Position for {task.title}
          </label>
          <select
            id={`${idPrefix}-position`}
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            value={position}
            disabled={locked || movement.dragDisabled}
            onChange={(event) => setPosition(event.target.value)}
          >
            {Array.from({ length: movement.total }, (_, index) => index + 1).map((slot) => (
              <option key={slot} value={String(slot)}>
                {slot} of {movement.total}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked || movement.dragDisabled}
          onClick={() => {
            const target = Number(position);
            if (Number.isInteger(target) && target >= 1 && target <= movement.total) {
              movement.onMove(target);
            }
          }}
        >
          Move to position
          <span className="sr-only"> {task.title}</span>
        </Button>
      </div>
    </div>
  );
}
