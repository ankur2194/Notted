import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectDetailLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-5" aria-label="Loading project" aria-busy="true">
      <Skeleton className="h-11 w-40" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}
