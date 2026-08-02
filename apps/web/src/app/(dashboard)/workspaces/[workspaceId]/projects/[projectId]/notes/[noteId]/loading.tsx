import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectNoteLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-4" aria-label="Loading project note">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-40" />
      <Skeleton className="h-96" />
    </div>
  );
}
