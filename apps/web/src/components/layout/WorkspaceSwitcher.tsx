"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ShellWorkspaceMembership } from "@notted/shared-types";

import { selectWorkspace } from "@/lib/shell/requests";

export function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  compact = false,
}: {
  readonly workspaces: readonly ShellWorkspaceMembership[];
  readonly currentWorkspace: ShellWorkspaceMembership | null;
  readonly compact?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  async function change(workspaceId: string): Promise<void> {
    if (workspaceId === currentWorkspace?.workspaceId) return;
    setState("loading");
    const result = await selectWorkspace(workspaceId);
    if (!result.ok) {
      setState("error");
      return;
    }
    setState("idle");
    router.push(`/?workspace=${encodeURIComponent(workspaceId)}`);
    router.refresh();
  }

  if (workspaces.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-3 text-sm" role="status">
        <p className="font-medium">No workspace access</p>
        {!compact && (
          <p className="mt-1 text-muted-foreground">
            Ask an administrator for access. Workspace creation arrives in Part 26.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label
        htmlFor={compact ? "mobile-workspace" : "workspace-switcher"}
        className={compact ? "sr-only" : "text-xs font-medium text-muted-foreground"}
      >
        Current workspace
      </label>
      <select
        id={compact ? "mobile-workspace" : "workspace-switcher"}
        aria-describedby={
          state === "error" ? `${compact ? "mobile-" : ""}workspace-error` : undefined
        }
        className="min-h-11 w-full rounded-md border bg-background px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
        value={currentWorkspace?.workspaceId ?? ""}
        onChange={(event) => void change(event.target.value)}
        disabled={state === "loading" || workspaces.length === 1}
      >
        {currentWorkspace === null && <option value="">Choose a workspace</option>}
        {workspaces.map((workspace) => (
          <option key={workspace.workspaceId} value={workspace.workspaceId}>
            {workspace.name} · {workspace.role}
          </option>
        ))}
      </select>
      {workspaces.length === 1 && !compact && (
        <p className="text-xs text-muted-foreground">Only one workspace is available.</p>
      )}
      {state === "loading" && (
        <p className="text-xs text-muted-foreground" role="status">
          Switching workspace…
        </p>
      )}
      {state === "error" && (
        <p
          id={`${compact ? "mobile-" : ""}workspace-error`}
          className="text-xs text-destructive"
          role="alert"
        >
          Workspace access changed or the server is unavailable. Select it again to retry.
        </p>
      )}
    </div>
  );
}
