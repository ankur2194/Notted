"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("Application error boundary", error.digest ?? "no-digest");
  }, [error]);

  return (
    <main
      className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4"
      id="main-content"
      tabIndex={-1}
    >
      <div className="text-center space-y-4" role="alert">
        <h1 className="text-2xl font-semibold text-foreground">Something went wrong</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          We encountered an unexpected error. Please try refreshing the page or navigate back to the
          dashboard.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button onClick={reset} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
