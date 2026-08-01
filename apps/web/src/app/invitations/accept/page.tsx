import { acceptWorkspaceInvitationSchema } from "@notted/shared-validators";
import { redirect } from "next/navigation";

import { AcceptWorkspaceInvitation } from "@/components/workspaces/AcceptWorkspaceInvitation";
import { loginPathFor } from "@/lib/auth/redirects";
import { getServerSession } from "@/lib/auth/server-session";

export default async function InvitationAcceptPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const tokenValue = parameters.token;
  const token = Array.isArray(tokenValue) ? tokenValue[0] : tokenValue;
  const parsed = acceptWorkspaceInvitationSchema.safeParse({ token });

  if (!parsed.success) {
    return (
      <main className="grid min-h-dvh place-items-center px-4">
        <section className="max-w-md space-y-3 rounded-xl border bg-card p-8" role="alert">
          <h1 className="text-2xl font-bold">Invitation unavailable</h1>
          <p className="text-muted-foreground">The invitation link is invalid or incomplete.</p>
        </section>
      </main>
    );
  }

  const session = await getServerSession();
  if (session.status === "unauthenticated") {
    redirect(loginPathFor(`/invitations/accept?token=${parsed.data.token}`));
  }
  if (session.status === "unavailable") {
    return (
      <main className="grid min-h-dvh place-items-center px-4">
        <section className="max-w-md space-y-3 rounded-xl border bg-card p-8" role="alert">
          <h1 className="text-2xl font-bold">Session unavailable</h1>
          <p className="text-muted-foreground">Your session could not be validated. Try again.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <section className="max-w-md space-y-4 rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-bold">Join workspace</h1>
        <p className="text-muted-foreground">
          Accept this single-use invitation to add the workspace to your account.
        </p>
        <AcceptWorkspaceInvitation token={parsed.data.token} />
      </section>
    </main>
  );
}
