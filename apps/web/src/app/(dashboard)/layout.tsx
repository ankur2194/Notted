import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import type { NoteNavigationState } from "@/components/notes/NoteTree";
import type { TagNavigationState } from "@/components/tags/TagFilterList";
import type { ReactNode } from "react";

import { DashboardShell } from "@/components/layout/DashboardShell";
import { publicEnvironment } from "@/config/public-environment";
import { loginPathFor } from "@/lib/auth/redirects";
import { getServerSession } from "@/lib/auth/server-session";
import { isPrimaryHost } from "@/lib/domains/custom-host";
import { getServerFolders, getServerNoteNavigation } from "@/lib/notes/server-notes";
import { getServerShell } from "@/lib/shell/server-shell";
import { getServerTags } from "@/lib/tags/server-tags";
import { PATHNAME_HEADER } from "@/proxy";

function UnavailableState({
  title,
  message,
}: {
  readonly title: string;
  readonly message: string;
}) {
  return (
    <main id="main-content" className="grid min-h-dvh place-items-center px-4">
      <div
        className="max-w-md space-y-4 rounded-xl border bg-card p-8 text-center shadow-sm"
        role="alert"
      >
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground">{message}</p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </div>
    </main>
  );
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // The page the visitor actually asked for, stamped on by `proxy.ts` because
  // the App Router hands a layout no pathname. Absent (a request the proxy
  // matcher skipped) falls back to "/", which is what this always did.
  const requestHeaders = await headers();
  const intendedPath = requestHeaders.get(PATHNAME_HEADER) ?? "/";
  const session = await getServerSession();
  if (session.status === "unauthenticated") redirect(loginPathFor(intendedPath));
  if (session.status === "unavailable") {
    return (
      <UnavailableState
        title="Session validation unavailable"
        message="Notted could not safely validate your session. No protected content was loaded."
      />
    );
  }

  const shell = await getServerShell();
  if (shell.status === "unauthenticated") redirect(loginPathFor(intendedPath));
  if (shell.status === "unavailable") {
    return (
      <UnavailableState
        title="Workspace shell unavailable"
        message="Your workspace memberships and notifications could not be loaded safely."
      />
    );
  }

  let noteNavigation: NoteNavigationState = { status: "no-workspace" };
  let tagNavigation: TagNavigationState = { status: "no-workspace" };
  if (shell.data.currentWorkspace !== null) {
    const workspaceId = shell.data.currentWorkspace.workspaceId;
    const [navigation, folders, tags] = await Promise.all([
      getServerNoteNavigation(workspaceId),
      getServerFolders(workspaceId),
      getServerTags(workspaceId),
    ]);
    noteNavigation =
      navigation.status === "ready" && folders.status === "ready"
        ? {
            status: "ready",
            navigation: navigation.data,
            folders: folders.data.items,
            foldersTruncated: folders.data.hasMore,
          }
        : { status: "unavailable" };
    // Tags fail independently of the note tree: an unreadable tag list must
    // not blank the note navigation next to it, and vice versa.
    tagNavigation =
      tags.status === "ready"
        ? { status: "ready", tags: tags.data.items, truncated: tags.data.hasMore }
        : { status: "unavailable" };
  }
  // Switching workspaces is refused on a tenant's own domain by two independent
  // guards -- the proxy 404s the POST, and the route handler requires the
  // primary origin -- both correctly, because a branded host must never render
  // another tenant's workspace. The switcher renders as a static label there
  // rather than as a control that always fails.
  const requestHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
  const canSwitchWorkspace = isPrimaryHost(
    requestHost,
    new URL(publicEnvironment.NEXT_PUBLIC_APP_URL).host,
  );
  return (
    <DashboardShell
      shell={shell.data}
      noteNavigation={noteNavigation}
      tagNavigation={tagNavigation}
      canSwitchWorkspace={canSwitchWorkspace}
    >
      {children}
    </DashboardShell>
  );
}
