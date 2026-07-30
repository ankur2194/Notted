import { Skeleton } from "@/components/ui/skeleton";

export default function AuthLoading() {
  return (
    <div
      className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-md items-center px-4"
      role="status"
    >
      <div className="w-full space-y-4 rounded-xl border border-border p-8">
        <span className="sr-only">Loading authentication page</span>
        <Skeleton className="mx-auto h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
