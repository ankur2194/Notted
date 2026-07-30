import { SHELL_API_PATHS } from "@notted/shared-types";
import { workspaceSelectorSchema } from "@notted/shared-validators";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

import { publicEnvironment } from "@/config/public-environment";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/shell/server-shell";

export async function POST(request: Request): Promise<NextResponse> {
  const requestHeaders = await headers();
  if (requestHeaders.get("origin") !== publicEnvironment.NEXT_PUBLIC_APP_URL) {
    return NextResponse.json({ error: "Workspace selection was rejected." }, { status: 403 });
  }
  const parsed = workspaceSelectorSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Workspace selection is invalid." }, { status: 400 });
  }

  const values = await cookies();
  const cookie = values
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const url = new URL(SHELL_API_PATHS.bootstrap, publicEnvironment.NEXT_PUBLIC_API_URL);
  url.searchParams.set("workspaceId", parsed.data.workspaceId);
  try {
    const authorization = await fetch(url, {
      cache: "no-store",
      headers: cookie.length > 0 ? { cookie } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!authorization.ok) {
      return NextResponse.json(
        { error: "Workspace selection was not available." },
        { status: authorization.status === 401 ? 401 : 404 },
      );
    }
    const response = NextResponse.json({ selected: true });
    response.cookies.set(WORKSPACE_SELECTION_COOKIE, parsed.data.workspaceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Workspace selection is unavailable." }, { status: 503 });
  }
}
