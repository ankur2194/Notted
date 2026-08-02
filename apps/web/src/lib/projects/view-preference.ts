import { uuidSchema } from "@notted/shared-validators";

export type ProjectViewPreference = "grid" | "list";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function projectViewPreferenceKey(workspaceId: string): string | null {
  const parsed = uuidSchema.safeParse(workspaceId);
  return parsed.success ? `notted:projects:view:${parsed.data}` : null;
}

export function readProjectViewPreference(
  storage: PreferenceStorage | null,
  workspaceId: string,
): ProjectViewPreference {
  const key = projectViewPreferenceKey(workspaceId);
  if (storage === null || key === null) return "grid";
  try {
    const value = storage.getItem(key);
    return value === "grid" || value === "list" ? value : "grid";
  } catch {
    return "grid";
  }
}

export function writeProjectViewPreference(
  storage: PreferenceStorage | null,
  workspaceId: string,
  preference: ProjectViewPreference,
): void {
  const key = projectViewPreferenceKey(workspaceId);
  if (storage === null || key === null || (preference !== "grid" && preference !== "list")) return;
  try {
    storage.setItem(key, preference);
  } catch {
    // Storage is a harmless enhancement; privacy modes and quotas may disable it.
  }
}
