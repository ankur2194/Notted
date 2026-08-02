import type { ProjectStatus } from "@notted/shared-types";

import { FormField } from "@/components/ui/form-controls";

export function ProjectFields({
  prefix,
  name,
  description,
  color,
  dueDate,
  status,
  disabled,
  onName,
  onDescription,
  onColor,
  onDueDate,
  onStatus,
}: {
  readonly prefix: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly dueDate: string;
  readonly status: ProjectStatus;
  readonly disabled: boolean;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
  readonly onColor: (value: string) => void;
  readonly onDueDate: (value: string) => void;
  readonly onStatus: (value: ProjectStatus) => void;
}) {
  return (
    <div className="space-y-4">
      <FormField
        id={`${prefix}-name`}
        label="Project name"
        value={name}
        onChange={(event) => onName(event.currentTarget.value)}
        disabled={disabled}
        required
        maxLength={255}
      />
      <div className="space-y-2">
        <label htmlFor={`${prefix}-description`} className="text-sm font-medium">
          Description (optional)
        </label>
        <textarea
          id={`${prefix}-description`}
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
          value={description}
          onChange={(event) => onDescription(event.currentTarget.value)}
          disabled={disabled}
          maxLength={5000}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`${prefix}-color`}
          label="Project color"
          type="color"
          value={color}
          onChange={(event) => onColor(event.currentTarget.value)}
          disabled={disabled}
        />
        <FormField
          id={`${prefix}-due-date`}
          label="Due date (optional)"
          type="date"
          value={dueDate}
          onChange={(event) => onDueDate(event.currentTarget.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${prefix}-status`} className="text-sm font-medium">
          Status
        </label>
        <select
          id={`${prefix}-status`}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
          value={status}
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "active" || value === "archived" || value === "completed")
              onStatus(value);
          }}
        >
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
      </div>
    </div>
  );
}
