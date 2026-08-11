import { uuidSchema } from "@notted/shared-validators";

export type TaskViewPreference = "list" | "board" | "calendar";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VALUES: readonly TaskViewPreference[] = ["list", "board", "calendar"];

function isPreference(value: unknown): value is TaskViewPreference {
  return typeof value === "string" && VALUES.includes(value as TaskViewPreference);
}

export function taskViewPreferenceKey(workspaceId: string): string | null {
  const parsed = uuidSchema.safeParse(workspaceId);
  return parsed.success ? `notted:tasks:view:${parsed.data}` : null;
}

export function readTaskViewPreference(
  storage: PreferenceStorage | null,
  workspaceId: string,
): TaskViewPreference {
  const key = taskViewPreferenceKey(workspaceId);
  if (storage === null || key === null) return "list";
  try {
    const value = storage.getItem(key);
    return isPreference(value) ? value : "list";
  } catch {
    return "list";
  }
}

export function writeTaskViewPreference(
  storage: PreferenceStorage | null,
  workspaceId: string,
  preference: TaskViewPreference,
): void {
  const key = taskViewPreferenceKey(workspaceId);
  if (storage === null || key === null || !isPreference(preference)) return;
  try {
    storage.setItem(key, preference);
  } catch {
    // Storage is a harmless enhancement; privacy modes and quotas may disable it.
  }
}
