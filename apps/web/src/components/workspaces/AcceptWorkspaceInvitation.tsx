"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorSummary, FormStatus } from "@/components/ui/form-controls";
import { selectWorkspace } from "@/lib/shell/requests";
import { acceptWorkspaceInvitation } from "@/lib/workspaces/invitation-requests";

export function AcceptWorkspaceInvitation({ token }: { readonly token: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");

  async function accept(): Promise<void> {
    setState("submitting");
    const result = await acceptWorkspaceInvitation(token);
    if (!result.ok) {
      setState("error");
      return;
    }
    await selectWorkspace(result.data.membership.workspaceId);
    router.replace(`/workspaces/${result.data.membership.workspaceId}`);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {state === "error" ? (
        <ErrorSummary message="This invitation is invalid, expired, already used, or unavailable." />
      ) : null}
      {state === "submitting" ? <FormStatus>Accepting invitation…</FormStatus> : null}
      <Button type="button" disabled={state === "submitting"} onClick={() => void accept()}>
        Accept workspace invitation
      </Button>
    </div>
  );
}
