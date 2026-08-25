import { passkeyClient } from "@better-auth/passkey/client";
import { AUTH_API_PATHS } from "@notted/shared-types";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { apiOrigin } from "@/lib/api/api-origin";

const authBasePath = AUTH_API_PATHS.login.slice(0, -"/sign-in/email".length);

/**
 * Part 73. `apiOrigin()` rather than the build-time value: on a custom host the
 * session cookie is host-only, so an auth call to the primary API origin would
 * carry no cookie at all. Evaluated at MODULE LOAD, which is a browser module —
 * `createAuthClient` needs a string, not a thunk, and this file is only ever
 * imported from client components.
 */
export const authClient = createAuthClient({
  baseURL: apiOrigin(),
  basePath: authBasePath,
  plugins: [magicLinkClient(), twoFactorClient(), passkeyClient()],
  fetchOptions: {
    credentials: "include",
    timeout: 10_000,
  },
});
