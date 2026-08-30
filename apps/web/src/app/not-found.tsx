import Link from "next/link";

export default function NotFound() {
  return (
    <main
      className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4"
      id="main-content"
      tabIndex={-1}
    >
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold text-muted-foreground">404</h1>
        <h2 className="text-2xl font-semibold text-foreground">Page not found</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          Sorry, we couldn&apos;t find the page you&apos;re looking for. It might have been moved or
          doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Go back home
        </Link>
      </div>
    </main>
  );
}
