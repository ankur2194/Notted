import { publicEnvironment } from "@/config/public-environment";
import { safeRedirectPath } from "@/lib/auth/redirects";

type ResultPath = "/magic-link" | "/verify-email";

export function authResultUrl(
  path: ResultPath,
  redirectTo: string,
  status?: "success" | "error",
): string {
  const url = new URL(path, publicEnvironment.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("redirect", safeRedirectPath(redirectTo));
  if (status !== undefined) url.searchParams.set("status", status);
  return url.toString();
}
