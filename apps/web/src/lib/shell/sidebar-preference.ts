export const SIDEBAR_PREFERENCE_KEY = "notted.shell.sidebar";

export type SidebarPreference = "expanded" | "collapsed";

export function parseSidebarPreference(value: string | null): SidebarPreference {
  return value === "collapsed" ? "collapsed" : "expanded";
}

export function readSidebarPreference(storage: Pick<Storage, "getItem"> | null): SidebarPreference {
  if (storage === null) return "expanded";
  try {
    return parseSidebarPreference(storage.getItem(SIDEBAR_PREFERENCE_KEY));
  } catch {
    return "expanded";
  }
}

export function writeSidebarPreference(
  storage: Pick<Storage, "setItem"> | null,
  value: SidebarPreference,
): void {
  if (storage === null) return;
  try {
    storage.setItem(SIDEBAR_PREFERENCE_KEY, value);
  } catch {
    // Storage can be unavailable in privacy modes. The in-memory UI still works.
  }
}
