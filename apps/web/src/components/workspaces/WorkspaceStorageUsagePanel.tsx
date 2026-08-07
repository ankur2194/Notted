"use client";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceStorageUsage } from "@/components/workspaces/WorkspaceStorageUsage";
import { workspaceQueryKeys } from "@/lib/workspaces/query-keys";
import { requestWorkspaceStorageUsage } from "@/lib/workspaces/requests";

/**
 * Client island that loads the Part 45 storage aggregate for the settings page.
 *
 * The overview page renders `WorkspaceStorageUsage` directly from a server
 * fetch; settings needs a client boundary because it is the surface a user
 * returns to after deleting files, so it wants a refresh affordance and honest
 * failure states rather than a value frozen at page render.
 *
 * The failure taxonomy is deliberate. `requestWorkspaceStorageUsage` collapses
 * 401/403/404 into `forbidden`, and since reading usage only needs
 * `settings.read` — which every role including `viewer` holds — a `forbidden`
 * here means the membership changed underneath an open page. That is a
 * permission notice, not an error with a retry button: retrying cannot grant
 * access, and offering the button would imply it might.
 *
 * `invalid` is folded into the retryable branch on purpose: a response that
 * fails the shared schema is a real fault, but it is not the user's, and the
 * only thing they can usefully do is ask again.
 */

type UsageFailure = "permission" | "retryable";

function StorageUsageNotice({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-muted/40 p-3 text-sm" role="note">
      {children}
    </p>
  );
}

export function WorkspaceStorageUsagePanel({ workspaceId }: { readonly workspaceId: string }) {
  const usage = useQuery({
    queryKey: workspaceQueryKeys.storage(workspaceId),
    queryFn: async () => {
      const result = await requestWorkspaceStorageUsage(workspaceId);
      // Resolving a failure to a zero-usage object would render a confident,
      // wrong "0 bytes used" bar. Throwing keeps the query in an error state
      // that the UI can label honestly.
      if (!result.ok) {
        const failure: UsageFailure = result.kind === "forbidden" ? "permission" : "retryable";
        throw new Error(failure);
      }
      return result.data;
    },
    // Overrides the provider's `retry: 1`. A denial is terminal, and for a fault
    // the request layer has already spent its 8s timeout — a silent retry only
    // delays the honest error state behind React Query's backoff. The explicit
    // Retry button below puts that decision where the user can see it.
    retry: false,
  });

  /*
   * Both transient branches announce through `aria-live="polite"` +
   * `aria-atomic="true"` — which is precisely what `role="status"` resolves to —
   * rather than through `role="status"` or `role="alert"` themselves.
   *
   * That is a deliberate choice, not a shortcut. This panel is embedded in the
   * settings form, which already owns the `status` and `alert` roles for save
   * and delete outcomes. A background usage read that is slow or failed is not
   * urgent and must not seize the assertive channel a destructive-action error
   * needs, nor add a second `status` region competing with the save
   * confirmation the user just triggered.
   */
  if (usage.isPending) {
    return (
      <div className="space-y-3" aria-busy="true" aria-live="polite" aria-atomic="true">
        <p className="text-sm text-muted-foreground">Loading storage usage…</p>
        <Skeleton className="h-3 w-full rounded-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (usage.isError) {
    if (usage.error.message === "permission") {
      return (
        <StorageUsageNotice>
          Storage usage is not available for your access to this workspace. Your membership may have
          changed — reload the page to see your current access.
        </StorageUsageNotice>
      );
    }
    return (
      <div className="space-y-3" aria-live="polite" aria-atomic="true">
        <p className="text-sm">
          Storage usage could not be loaded. Nothing about your files has changed.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void usage.refetch()}
          disabled={usage.isFetching}
        >
          {usage.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  return <WorkspaceStorageUsage usage={usage.data} />;
}
