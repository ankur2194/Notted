import Link from "next/link";

import { CreateNoteDialog } from "@/components/demo/create-note-dialog";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Public dashboard placeholder at `/`.
 *
 * This is a Server Component: the welcome heading, feature cards, skeleton
 * section, and getting-started links are all rendered on the server. The only
 * client island is `<CreateNoteDialog />`, which owns the Dialog + toast preview.
 */
export default function DashboardPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-12">
      <section aria-labelledby="welcome-heading" className="text-center space-y-4">
        <h1 id="welcome-heading" className="text-4xl font-bold tracking-tight text-foreground">
          Welcome to Notted
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Your corporate notes management platform. Organize projects, collaborate with your team,
          and keep everything in sync with a clean, paper-like writing experience.
        </p>
      </section>

      <section aria-labelledby="features-heading" className="space-y-6">
        <h2 id="features-heading" className="text-2xl font-semibold text-foreground">
          Key Features
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <article className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-medium text-foreground mb-2">Rich Text Editing</h3>
            <p className="text-muted-foreground text-sm">
              Full-featured editor with formatting, tables, checklists, and markdown shortcuts.
            </p>
          </article>
          <article className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-medium text-foreground mb-2">Project Organization</h3>
            <p className="text-muted-foreground text-sm">
              Group notes into projects, create hierarchies, and manage tasks with due dates.
            </p>
          </article>
          <article className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-medium text-foreground mb-2">Team Collaboration</h3>
            <p className="text-muted-foreground text-sm">
              Real-time editing, comments, mentions, and version history for seamless teamwork.
            </p>
          </article>
        </div>
      </section>

      <section aria-labelledby="demo-heading" className="space-y-4">
        <h2 id="demo-heading" className="text-2xl font-semibold text-foreground">
          Interactive Demo
        </h2>
        <p className="text-muted-foreground">
          Preview the dialog and toast notification primitives:
        </p>
        <CreateNoteDialog />
      </section>

      <section aria-labelledby="loading-heading" className="space-y-4">
        <h2 id="loading-heading" className="text-2xl font-semibold text-foreground">
          Loading States
        </h2>
        <p className="text-muted-foreground">
          Skeleton placeholders for content loading (decorative, hidden from screen readers):
        </p>
        <div className="space-y-4" aria-hidden="true">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      </section>

      <section
        aria-labelledby="getting-started-heading"
        className="space-y-4 pt-8 border-t border-border"
      >
        <h2 id="getting-started-heading" className="text-2xl font-semibold text-foreground">
          Getting Started
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <article className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-medium text-foreground mb-2">Sign In</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Visit the login page to see the authentication scaffold.
            </p>
            <Link href="/login" className="text-sm font-medium text-primary hover:underline">
              Go to Login &rarr;
            </Link>
          </article>
        </div>
      </section>
    </div>
  );
}
