import type { IsoTimestamp, UserId } from "./common";

export const AUTH_API_PATHS = Object.freeze({
  register: "/api/auth/sign-up/email",
  login: "/api/auth/sign-in/email",
  logout: "/api/auth/sign-out",
  providerSession: "/api/auth/get-session",
  principalSession: "/api/v1/auth/session",
  resendVerification: "/api/auth/send-verification-email",
  verifyEmail: "/api/auth/verify-email",
  requestMagicLink: "/api/auth/sign-in/magic-link",
  verifyMagicLink: "/api/auth/magic-link/verify",
  requestPasswordReset: "/api/auth/notted/request-password-reset",
  resetPassword: "/api/auth/notted/reset-password",
  reauthenticate: "/api/auth/notted/reauthenticate",
  capabilities: "/api/v1/auth/capabilities",
  security: "/api/v1/auth/security",
  sessions: "/api/v1/auth/sessions",
  revokeOtherSessions: "/api/v1/auth/sessions/revoke-others",
} as const);

export type AuthenticationMethod = "opaque-session";
export type AuthenticationAssurance = "single-factor";
export type OAuthProviderId = "google" | "github" | "microsoft";

export interface OAuthProviderSummary {
  readonly id: OAuthProviderId;
  readonly label: string;
}

/** Browser-safe authentication feature metadata. Credentials are never projected. */
export interface AuthCapabilities {
  readonly oauthProviders: readonly OAuthProviderSummary[];
  readonly passkeyEnabled: boolean;
  readonly twoFactorEnabled: boolean;
  readonly nonRememberedSessionSeconds: number;
  readonly rememberedSessionSeconds: number;
  readonly recentAuthenticationSeconds: number;
}

/** Safe projection of a server-validated Better Auth session. */
export interface AuthenticatedPrincipal {
  readonly userId: UserId;
  readonly sessionId: string;
  readonly method: AuthenticationMethod;
  readonly assurance: AuthenticationAssurance;
  readonly expiresAt: IsoTimestamp;
  readonly authenticatedAt: IsoTimestamp;
  readonly isFresh: boolean;
}

export interface AuthSessionSummary {
  readonly id: string;
  readonly current: boolean;
  readonly device: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface AuthPasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: IsoTimestamp;
}

export interface AuthSecurityOverview {
  readonly twoFactorEnabled: boolean;
  readonly sessions: readonly AuthSessionSummary[];
  readonly passkeys: readonly AuthPasskeySummary[];
}

/** Generic response for anti-enumeration email request endpoints. */
export interface AuthEmailAccepted {
  readonly status: "accepted";
}

/**
 * Safe user display fields. Credential, account, session, token, two-factor,
 * passkey and provider fields are deliberately owned by Better Auth.
 */
export interface UserSummary {
  id: UserId;
  name: string;
}

export interface UserDetail extends UserSummary {
  email: string;
  emailVerifiedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
