import { MEMBERSHIP_API_PATHS, type WorkspaceInvitationAcceptResult } from "@notted/shared-types";
import {
  acceptWorkspaceInvitationSchema,
  workspaceInvitationAcceptResultSchema,
} from "@notted/shared-validators";

import { publicEnvironment } from "@/config/public-environment";

export type InvitationAcceptRequestResult =
  | { readonly ok: true; readonly data: WorkspaceInvitationAcceptResult }
  | { readonly ok: false; readonly kind: "invalid" | "unavailable" };

export async function acceptWorkspaceInvitation(
  token: string,
): Promise<InvitationAcceptRequestResult> {
  const input = acceptWorkspaceInvitationSchema.safeParse({ token });
  if (!input.success) return { ok: false, kind: "invalid" };
  try {
    const response = await fetch(
      new URL(MEMBERSHIP_API_PATHS.acceptInvitation, publicEnvironment.NEXT_PUBLIC_API_URL),
      {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.data),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        kind: response.status === 400 || response.status === 409 ? "invalid" : "unavailable",
      };
    }
    const parsed = workspaceInvitationAcceptResultSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "unavailable" };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}
