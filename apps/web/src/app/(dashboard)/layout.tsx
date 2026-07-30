import Link from "next/link";
import { redirect } from "next/navigation";

import type { ReactNode } from "react";

import { DashboardShell } from "@/components/layout/DashboardShell";
import { loginPathFor } from "@/lib/auth/redirects";
import { getServerSession } from "@/lib/auth/server-session";
import { getServerShell } from "@/lib/shell/server-shell";

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
  const session = await getServerSession();
  if (session.status === "unauthenticated") redirect(loginPathFor("/"));
  if (session.status === "unavailable") {
    return (
      <UnavailableState
        title="Session validation unavailable"
        message="Notted could not safely validate your session. No protected content was loaded."
      />
    );
  }

  const shell = await getServerShell();
  if (shell.status === "unauthenticated") redirect(loginPathFor("/"));
  if (shell.status === "unavailable") {
    return (
      <UnavailableState
        title="Workspace shell unavailable"
        message="Your workspace memberships and notifications could not be loaded safely."
      />
    );
  }

  return <DashboardShell shell={shell.data}>{children}</DashboardShell>;
}
