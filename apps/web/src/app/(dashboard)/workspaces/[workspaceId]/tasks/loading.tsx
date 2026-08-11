import { Skeleton } from "@/components/ui/skeleton";

export default function WorkspaceTasksLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-4" aria-label="Loading tasks">
      <Skeleton className="h-12 w-56" />
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
