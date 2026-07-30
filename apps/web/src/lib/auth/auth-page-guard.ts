import "server-only";

import { redirect } from "next/navigation";

import { safeRedirectPath } from "@/lib/auth/redirects";
import { getServerSession } from "@/lib/auth/server-session";

export async function redirectAuthenticatedFromAuthPage(redirectTo = "/"): Promise<void> {
  const session = await getServerSession();
  if (session.status === "authenticated") redirect(safeRedirectPath(redirectTo));
}
