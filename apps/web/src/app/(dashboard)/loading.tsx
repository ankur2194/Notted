import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div
      className="min-h-dvh bg-background"
      aria-busy="true"
      aria-label="Loading application shell"
    >
      <span className="sr-only" role="status">
        Loading application shell…
      </span>
      <div className="flex min-h-dvh">
        <div className="hidden w-72 space-y-4 border-r p-4 md:block">
          <Skeleton className="h-11 w-36" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="flex-1">
          <div className="flex h-16 items-center gap-4 border-b px-5">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="ml-auto h-11 w-64" />
            <Skeleton className="size-11 rounded-full" />
          </div>
          <div className="space-y-5 p-6">
            <Skeleton className="h-44 w-full rounded-2xl" />
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
