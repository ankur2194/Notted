import Link from "next/link";

import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="text-xl font-bold text-foreground" aria-label="Notted Home">
            Notted
          </Link>
        </div>
      </header>
      <main id="main-content" className="flex-1" role="main">
        <div className="container mx-auto py-8 px-4">{children}</div>
      </main>
      <footer className="border-t border-border py-4">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Notted. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
