import Link from "next/link";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="font-semibold text-xl text-foreground" aria-label="Notted home">
            Notted
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1" role="main">
        {children}
      </main>
      <footer className="border-t border-border py-4">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Notted. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
