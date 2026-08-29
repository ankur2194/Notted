"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ShellWorkspaceMembership } from "@notted/shared-types";

import { publicEnvironment } from "@/config/public-environment";
import { selectWorkspace } from "@/lib/shell/requests";

export function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  compact = false,
  canSwitch = true,
}: {
  readonly workspaces: readonly ShellWorkspaceMembership[];
  readonly currentWorkspace: ShellWorkspaceMembership | null;
  readonly compact?: boolean;
  /**
   * False on a tenant's custom domain, where switching CANNOT work and must not
   * be offered. Two independent guards refuse it there, both correctly: the
   * proxy 404s `POST /api/shell/workspace` on a non-primary host, and the route
   * handler itself requires the request origin to be the primary app URL. A
   * branded host rendering another tenant's workspace under that tenant's
   * certificate is the incoherence Part 73 exists to prevent.
   *
   * So the fix is not to relax either guard — it is to stop rendering a control
   * whose every use ends in "Workspace access changed or the server is
   * unavailable", which reads as a permissions problem the visitor cannot act
   * on.
   */
  readonly canSwitch?: boolean;
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
            Create a workspace or ask an administrator for access.
          </p>
        )}
        {!compact ? (
          <Link
            href="/workspaces"
            className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline"
          >
            View workspaces
          </Link>
        ) : null}
      </div>
    );
  }

  if (!canSwitch) {
    return (
      <div className="space-y-1" data-testid="workspace-switcher-static">
        <p className="text-xs font-medium text-muted-foreground">Current workspace</p>
        <p className="text-sm font-medium">
          {currentWorkspace === null ? "No workspace selected" : currentWorkspace.name}
        </p>
        {!compact && (
          <p className="text-xs text-muted-foreground">
            This workspace has its own domain. Switch workspaces on{" "}
            <a
              href={publicEnvironment.NEXT_PUBLIC_APP_URL}
              className="font-medium text-primary hover:underline"
            >
              {new URL(publicEnvironment.NEXT_PUBLIC_APP_URL).host}
            </a>
            .
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
