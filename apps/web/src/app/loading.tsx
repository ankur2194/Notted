import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-screen items-center justify-center"
      role="main"
    >
      <div className="space-y-4 w-full max-w-md px-4" role="status" aria-label="Loading page">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <span className="sr-only">Loading...</span>
      </div>
    </main>
  );
}
