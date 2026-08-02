"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { NoteSummary } from "@notted/shared-types";

import { Button } from "@/components/ui/button";

export function RenameNoteControl({
  note,
  pending,
  onRename,
}: {
  readonly note: NoteSummary;
  readonly pending: boolean;
  readonly onRename: (title: string) => Promise<boolean>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(note.title), [note.title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setEditing(true)}
      >
        Rename
      </Button>
    );
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-2 sm:flex-row"
      onSubmit={(event) => {
        event.preventDefault();
        void onRename(title).then((ok) => ok && setEditing(false));
      }}
    >
      <label htmlFor={id} className="sr-only">
        New note title
      </label>
      <input
        ref={inputRef}
        id={id}
        className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        value={title}
        maxLength={500}
        disabled={pending}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || title.trim().length === 0}>
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setTitle(note.title);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
