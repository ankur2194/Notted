import { passkeyClient } from "@better-auth/passkey/client";
import { AUTH_API_PATHS } from "@notted/shared-types";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { publicEnvironment } from "@/config/public-environment";

const authBasePath = AUTH_API_PATHS.login.slice(0, -"/sign-in/email".length);

export const authClient = createAuthClient({
  baseURL: publicEnvironment.NEXT_PUBLIC_API_URL,
  basePath: authBasePath,
  plugins: [magicLinkClient(), twoFactorClient(), passkeyClient()],
  fetchOptions: {
    credentials: "include",
    timeout: 10_000,
  },
});
