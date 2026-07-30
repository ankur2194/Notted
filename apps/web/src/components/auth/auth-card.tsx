import type { ReactNode } from "react";

export function AuthCard({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-4 py-12">
      <section className="w-full max-w-md space-y-6 rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {children}
      </section>
    </div>
  );
}
