"use client";

import { taskTitleSchema } from "@notted/shared-validators";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * The one-field add row.
 *
 * Everything else about a task is edited in place afterwards, so the fast path
 * is a title and Enter — a dialog here would put four keystrokes of chrome in
 * front of the most repeated action on the page.
 */
export function CreateTaskForm({
  disabled,
  onCreate,
}: {
  readonly disabled: boolean;
  /**
   * Resolves `true` once the task exists. The temporary id keys the optimistic
   * row; the idempotency key is stable across retries of the same title, so a
   * repeat after a timeout cannot create a duplicate.
   */
  readonly onCreate: (
    title: string,
    temporaryId: string,
    idempotencyKey: string,
  ) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const submission = useRef<{ readonly fingerprint: string; readonly key: string } | null>(null);
  const valid = taskTitleSchema.safeParse(title).success;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = taskTitleSchema.safeParse(title);
        if (!parsed.success || disabled) return;
        if (submission.current?.fingerprint !== parsed.data) {
          submission.current = { fingerprint: parsed.data, key: globalThis.crypto.randomUUID() };
        }
        setPending(true);
        void onCreate(parsed.data, globalThis.crypto.randomUUID(), submission.current.key).then(
          (ok) => {
            setPending(false);
            if (!ok) return;
            submission.current = null;
            setTitle("");
          },
        );
      }}
    >
      <div className="min-w-48 flex-1 space-y-1">
        <label className="text-sm font-medium" htmlFor="create-task-title">
          New task
        </label>
        <input
          id="create-task-title"
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
          value={title}
          maxLength={500}
          disabled={disabled || pending}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={disabled || pending || !valid}>
        {pending ? "Adding…" : "Add task"}
      </Button>
    </form>
  );
}
