import { uuidSchema } from "@notted/shared-validators";

export type NoteViewMode = "grid" | "list" | "board" | "timeline";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VALUES: readonly NoteViewMode[] = ["grid", "list", "board", "timeline"];

function isMode(value: unknown): value is NoteViewMode {
  return typeof value === "string" && VALUES.includes(value as NoteViewMode);
}

/**
 * Scoped per project as well as per workspace: board and timeline only exist on
 * a project mount, so a workspace-wide key would keep restoring a mode the
 * unfiled note list cannot offer.
 */
export function noteViewPreferenceKey(
  workspaceId: string,
  projectId: string | null,
): string | null {
  const parsed = uuidSchema.safeParse(workspaceId);
  return parsed.success ? `notted:notes:view:${parsed.data}:${projectId ?? "root"}` : null;
}

export function readNoteViewPreference(
  storage: PreferenceStorage | null,
  workspaceId: string,
  projectId: string | null,
): NoteViewMode {
  const key = noteViewPreferenceKey(workspaceId, projectId);
  if (storage === null || key === null) return "list";
  try {
    const value = storage.getItem(key);
    return isMode(value) ? value : "list";
  } catch {
    return "list";
  }
}

export function writeNoteViewPreference(
  storage: PreferenceStorage | null,
  workspaceId: string,
  projectId: string | null,
  preference: NoteViewMode,
): void {
  const key = noteViewPreferenceKey(workspaceId, projectId);
  if (storage === null || key === null || !isMode(preference)) return;
  try {
    storage.setItem(key, preference);
  } catch {
    // Storage is a harmless enhancement; privacy modes and quotas may disable it.
  }
}
