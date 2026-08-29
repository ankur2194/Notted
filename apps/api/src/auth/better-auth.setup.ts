import { createHmac, randomBytes } from "node:crypto";

import {
  oauthProviderIdSchema,
  passkeyNameSchema,
  reauthenticateSchema,
  recoveryCodeSchema,
  registerWithPasswordSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  totpCodeSchema,
} from "@notted/shared-validators";
import { eq } from "drizzle-orm";

import { BETTER_AUTH_SCHEMA_CONTRACT, schema, users } from "../database/schema";

import { AuthLockoutError } from "./auth-lockout.service";

import type { AuthEmailProducerService } from "./auth-email-producer.service";
import type { AuthLockoutService } from "./auth-lockout.service";
import type { BetterAuthRedisStorage } from "./better-auth-redis.storage";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { AuthConfig } from "../config/auth.config";
import type { FeaturesConfig } from "../config/features.config";
import type { RetentionConfig } from "../config/retention.config";
import type { DatabaseService } from "../database/database.service";
import type { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import type { Auth } from "better-auth";

export const RECENT_AUTHENTICATION_PATHS = Object.freeze([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/link-social",
  "/unlink-account",
  "/change-email",
  "/change-password",
  "/set-password",
  "/delete-user",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

/**
 * Part 74 — the paths that carry a caller-supplied identifier in the body and
 * are therefore worth counting per identifier rather than only per IP. OAuth
 * and passkey paths are absent on purpose: neither accepts a guessable secret,
 * and locking on them would let one attacker lock a victim out of their own
 * provider sign-in.
 */
/** The one identifier path that must stay reachable while an account is locked. */
export const AUTH_PASSWORD_RESET_PATH = "/notted/request-password-reset";

export const AUTH_IDENTIFIER_PATHS = Object.freeze([
  "/sign-in/email",
  "/sign-up/email",
  "/sign-in/magic-link",
  AUTH_PASSWORD_RESET_PATH,
]);

const SESSION_ROTATION_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/disable"]);
const NON_REMEMBERED_SESSION_MILLISECONDS = 24 * 60 * 60 * 1_000;

interface SessionLifetime {
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

function isNonRememberedSession(session: SessionLifetime): boolean {
  return (
    session.expiresAt.getTime() - session.createdAt.getTime() <= NON_REMEMBERED_SESSION_MILLISECONDS
  );
}

/**
 * Better Auth 1.6.24 rotates a session while confirming or disabling TOTP but
 * passes `dontRememberMe=false` for that internal rotation. Preserve the
 * user's existing one-day choice instead of silently upgrading it to a
 * remembered session. Login challenges have no active session and are left to
 * Better Auth's signed `dontRememberMe` challenge cookie.
 */
export function preserveNonRememberedRotationExpiry(
  path: string | undefined,
  proposed: SessionLifetime,
  active: SessionLifetime | undefined,
): Date {
  if (path === undefined || !SESSION_ROTATION_PATHS.has(path) || active === undefined) {
    return proposed.expiresAt;
  }
  if (!isNonRememberedSession(active)) return proposed.expiresAt;
  return new Date(proposed.createdAt.getTime() + NON_REMEMBERED_SESSION_MILLISECONDS);
}

function requestCorrelationId(request: Request | undefined): string | undefined {
  const value = request?.headers.get("x-request-id");
  if (value === null || value === undefined) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

function tokenHash(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

const identifierPaths = new Set(AUTH_IDENTIFIER_PATHS);

/**
 * The email a request is attempting, or `undefined` when the path does not
 * carry one. Anything that is not a plausible address is ignored rather than
 * counted: hashing arbitrary attacker-controlled bytes would let them fill
 * Redis with keys that lock nothing.
 */
function attemptedIdentifier(path: string, body: unknown): string | undefined {
  if (!identifierPaths.has(path) || typeof body !== "object" || body === null) return undefined;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== "string" || email.length === 0 || email.length > 320) return undefined;
  return email.includes("@") ? email : undefined;
}

export interface BetterAuthSetupDependencies {
  readonly database: DatabaseService;
  readonly redisStorage: BetterAuthRedisStorage;
  readonly emailProducer: AuthEmailProducerService;
  readonly workspaceEmailProducer: WorkspaceEmailProducerService;
  readonly authConfig: AuthConfig;
  readonly appConfig: AppConfig;
  readonly retention: RetentionConfig;
  readonly features: FeaturesConfig;
  readonly logger: StructuredLogger;
  /**
   * Part 73. Supplies the VERIFIED custom-domain origins Better Auth must also
   * trust. Optional so a caller that has no custom-domain support (and the unit
   * suite) keeps the static list unchanged.
   */
  readonly verifiedHosts?: {
    verifiedOriginsFor(protocol?: "http" | "https"): Promise<readonly string[]>;
  };
  /**
   * Part 74. Optional for the same reason as `verifiedHosts`: the unit suite
   * builds this options object without Redis, and an absent lockout simply
   * leaves the per-IP limiter as the only brute-force bound.
   */
  readonly lockout?: AuthLockoutService;
}

export function betterAuthCookieAttributes(production: boolean) {
  return Object.freeze({
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
  });
}

export function configuredSocialProviders(config: AuthConfig, disableSignUp = false) {
  return Object.freeze({
    ...(config.oauth.google === undefined
      ? {}
      : {
          google: {
            clientId: config.oauth.google.clientId,
            clientSecret: config.oauth.google.clientSecret,
            disableSignUp,
          },
        }),
    ...(config.oauth.github === undefined
      ? {}
      : {
          github: {
            clientId: config.oauth.github.clientId,
            clientSecret: config.oauth.github.clientSecret,
            disableSignUp,
          },
        }),
    ...(config.oauth.microsoft === undefined
      ? {}
      : {
          microsoft: {
            clientId: config.oauth.microsoft.clientId,
            clientSecret: config.oauth.microsoft.clientSecret,
            tenantId: config.oauth.microsoft.tenantId,
            disableSignUp,
          },
        }),
  });
}

export function passkeyPluginOptions(config: AuthConfig) {
  return Object.freeze({
    rpName: "Notted",
    rpID: config.passkeyRpId,
    origin: [...config.passkeyOrigins],
    registration: { requireSession: true } as const,
    authenticatorSelection: {
      residentKey: "preferred" as const,
      userVerification: "required" as const,
    },
  });
}

export function twoFactorPluginOptions(config: AuthConfig) {
  return Object.freeze({
    issuer: "Notted",
    allowPasswordless: true,
    twoFactorCookieMaxAge: config.twoFactorChallengeSeconds,
    backupCodeOptions: { storeBackupCodes: "encrypted" as const },
    accountLockout: {
      enabled: true,
      maxFailedAttempts: config.twoFactorLockoutAttempts,
      durationSeconds: config.twoFactorLockoutSeconds,
    },
  });
}

export async function setupBetterAuth(dependencies: BetterAuthSetupDependencies): Promise<Auth> {
  const [
    { betterAuth },
    {
      APIError,
      createAuthEndpoint,
      createAuthMiddleware,
      formCsrfMiddleware,
      getAuthoritativeSessionFromCtx,
      isAPIError,
      sessionMiddleware,
    },
    { magicLink, twoFactor },
    { setSessionCookie },
    { passkey },
    { drizzleAdapter },
  ] = await Promise.all([
    import("better-auth"),
    import("better-auth/api"),
    import("better-auth/plugins"),
    import("better-auth/cookies"),
    import("@better-auth/passkey"),
    import("@better-auth/drizzle-adapter"),
  ]);
  const { authConfig, appConfig, retention, features, emailProducer, database } = dependencies;
  const nonRememberedRotationCookies = new WeakMap<
    Request,
    Parameters<typeof setSessionCookie>[1]
  >();
  if (!features.emailEnabled && features.registrationEnabled) {
    throw new Error("Email must be enabled while self-service registration is enabled");
  }

  const genericAccepted = {
    status: true,
    message: "If this email exists, check your inbox for next steps",
  } as const;

  const requestPasswordReset = createAuthEndpoint(
    "/notted/request-password-reset",
    { method: "POST", body: requestPasswordResetSchema, use: [formCsrfMiddleware] },
    async (ctx) => {
      const match = await ctx.context.internalAdapter.findUserByEmail(ctx.body.email, {
        includeAccounts: true,
      });
      if (!match) {
        await ctx.context.internalAdapter.findVerificationValue("notted-reset:dummy");
        return ctx.json(genericAccepted);
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + authConfig.passwordResetTokenTtlSeconds * 1_000);
      await ctx.context.internalAdapter.createVerificationValue({
        identifier: `notted-reset:${tokenHash(authConfig.secret, token)}`,
        value: match.user.id,
        expiresAt,
      });
      const actionUrl = new URL("/reset-password", appConfig.appUrl);
      actionUrl.searchParams.set("token", token);
      await emailProducer.queue({
        recipient: match.user.email,
        purpose: "password_reset_request",
        context: { actionUrl: actionUrl.toString() },
        expiresAt,
        correlationId: requestCorrelationId(ctx.request),
      });
      return ctx.json(genericAccepted);
    },
  );

  const resetPassword = createAuthEndpoint(
    "/notted/reset-password",
    { method: "POST", body: resetPasswordSchema, use: [formCsrfMiddleware] },
    async (ctx) => {
      const verification = await ctx.context.internalAdapter.consumeVerificationValue(
        `notted-reset:${tokenHash(authConfig.secret, ctx.body.token)}`,
      );
      if (!verification || verification.expiresAt.getTime() <= Date.now()) {
        throw APIError.from("BAD_REQUEST", {
          code: "INVALID_TOKEN",
          message: "Invalid or expired reset link",
        });
      }
      const hashedPassword = await ctx.context.password.hash(ctx.body.newPassword);
      const accounts = await ctx.context.internalAdapter.findAccounts(verification.value);
      if (accounts.some((account) => account.providerId === "credential")) {
        await ctx.context.internalAdapter.updatePassword(verification.value, hashedPassword);
      } else {
        await ctx.context.internalAdapter.createAccount({
          userId: verification.value,
          providerId: "credential",
          accountId: verification.value,
          password: hashedPassword,
        });
      }
      await ctx.context.internalAdapter.deleteUserSessions(verification.value);
      const user = await ctx.context.internalAdapter.findUserById(verification.value);
      if (user !== null) {
        await emailProducer.queue({
          recipient: user.email,
          purpose: "password_reset_confirmation",
          context: {},
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
          correlationId: requestCorrelationId(ctx.request),
        });
      }
      return ctx.json({ status: true });
    },
  );

  const reauthenticate = createAuthEndpoint(
    "/notted/reauthenticate",
    {
      method: "POST",
      body: reauthenticateSchema,
      use: [formCsrfMiddleware, sessionMiddleware],
    },
    async (ctx) => {
      const current = ctx.context.session;
      await ctx.context.password.checkPassword(current.user.id, ctx);
      const dontRememberMe =
        current.session.expiresAt.getTime() - current.session.createdAt.getTime() <=
        24 * 60 * 60 * 1_000;
      const nextSession = await ctx.context.internalAdapter.createSession(
        current.user.id,
        dontRememberMe,
        current.session,
      );
      await setSessionCookie(ctx, { session: nextSession, user: current.user }, dontRememberMe);
      await ctx.context.internalAdapter.deleteSession(current.session.token);
      return ctx.json({ status: true });
    },
  );

  const recentAuthenticationPaths = new Set(RECENT_AUTHENTICATION_PATHS);

  /**
   * Part 74. Better Auth's own `APIError` is the only refusal shape its handler
   * knows how to serialise, so the transport-neutral error is translated here
   * rather than thrown from the service. `Retry-After` is a real header the
   * client can act on; the body message is identical for every outcome.
   */
  const throwAsApiError = (error: AuthLockoutError): never => {
    throw new APIError(
      error.status === 423 ? "LOCKED" : "TOO_MANY_REQUESTS",
      { code: error.code, message: error.message },
      { "Retry-After": String(error.retryAfterSeconds) },
    );
  };

  const authBoundaryHook = createAuthMiddleware({}, async (ctx) => {
    // FIRST, before any validation, session lookup or password hash: a refused
    // attempt must cost the server less than it costs the attacker.
    const identifier = attemptedIdentifier(ctx.path, ctx.body);
    if (identifier !== undefined && dependencies.lockout !== undefined) {
      try {
        await dependencies.lockout.consumeIdentifierBudget(identifier, ctx.path);
        /*
         * PASSWORD RESET IS THE WAY OUT OF A LOCKOUT, so the lockout must not
         * gate it.
         *
         * Only `/sign-in/email` failures call `recordFailure`, and each new lock
         * runs for `lockoutSeconds` from the moment it is set — so an attacker
         * who can spend the attempt budget can hold a victim's lock open
         * indefinitely. If the lock also sealed the reset endpoint, the victim's
         * only escape hatch would be closed by the attack itself: a permanent,
         * attacker-sustained denial of service on someone who did nothing.
         *
         * The endpoint is not left open — it keeps its own per-identifier budget
         * above (its real abuse is mail-bombing an inbox, which a per-identifier
         * budget is exactly the right axis for) plus the per-IP bucket in
         * `AuthRateLimitMiddleware`.
         */
        if (ctx.path !== AUTH_PASSWORD_RESET_PATH) {
          await dependencies.lockout.assertNotLocked(identifier);
        }
      } catch (error: unknown) {
        if (error instanceof AuthLockoutError) throwAsApiError(error);
        throw error;
      }
    }
    if (ctx.path === "/sign-in/social") {
      const provider = oauthProviderIdSchema.safeParse(ctx.body?.provider);
      if (!provider.success || !authConfig.enabledOAuthProviders.includes(provider.data)) {
        throw APIError.from("BAD_REQUEST", {
          code: "OAUTH_PROVIDER_UNAVAILABLE",
          message: "This sign-in provider is unavailable",
        });
      }
    }
    if (ctx.path === "/sign-up/email") {
      const parsed = registerWithPasswordSchema.safeParse(ctx.body);
      if (!parsed.success) {
        throw APIError.from("BAD_REQUEST", {
          code: "PASSWORD_POLICY_FAILED",
          message: "Password does not meet the required strength policy",
        });
      }
    }
    if (
      (ctx.path === "/passkey/generate-register-options" ||
        ctx.path === "/passkey/verify-registration") &&
      typeof (ctx.path === "/passkey/generate-register-options"
        ? ctx.query?.name
        : ctx.body?.name) === "string"
    ) {
      const name =
        ctx.path === "/passkey/generate-register-options" ? ctx.query?.name : ctx.body?.name;
      if (!passkeyNameSchema.safeParse(name).success) {
        throw APIError.from("BAD_REQUEST", {
          code: "INVALID_PASSKEY_NAME",
          message: "Passkey name must be between 1 and 64 characters",
        });
      }
    }
    if (
      ctx.path === "/two-factor/verify-totp" &&
      !totpCodeSchema.safeParse(ctx.body?.code).success
    ) {
      throw APIError.from("BAD_REQUEST", { code: "INVALID_CODE", message: "Invalid code" });
    }
    if (
      ctx.path === "/two-factor/verify-backup-code" &&
      !recoveryCodeSchema.safeParse(ctx.body?.code).success
    ) {
      throw APIError.from("BAD_REQUEST", { code: "INVALID_CODE", message: "Invalid code" });
    }
    const enrollmentConfirmation = ctx.path === "/two-factor/verify-totp";
    if (recentAuthenticationPaths.has(ctx.path) || enrollmentConfirmation) {
      const session = await getAuthoritativeSessionFromCtx(ctx);
      if (session === null && enrollmentConfirmation) {
        // A sign-in challenge deliberately has no authenticated session. The
        // two-factor plugin validates its short-lived signed challenge cookie.
        return;
      }
      if (session === null) {
        throw APIError.from("UNAUTHORIZED", {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        });
      }
      if (ctx.path === "/two-factor/enable" && session.user.twoFactorEnabled === true) {
        throw APIError.from("BAD_REQUEST", {
          code: "TWO_FACTOR_ALREADY_ENABLED",
          message: "Two-factor authentication is already enabled",
        });
      }
      if (
        Date.now() - session.session.createdAt.getTime() >=
        authConfig.recentAuthenticationSeconds * 1_000
      ) {
        throw APIError.from("FORBIDDEN", {
          code: "RECENT_AUTHENTICATION_REQUIRED",
          message: "Recent authentication is required",
        });
      }
    }
  });

  // Better Auth 1.6.24 accepts exactly ONE `hooks.after` middleware (see
  // `@better-auth/core` init-options: `after?: AuthMiddleware`, not an array),
  // so the two after-request concerns are composed here rather than registered
  // separately. Order matters only in that the cookie must be written before
  // anything can throw.
  const afterHook = createAuthMiddleware({}, async (ctx) => {
    if (ctx.request !== undefined) {
      const rotation = nonRememberedRotationCookies.get(ctx.request);
      if (rotation !== undefined) {
        nonRememberedRotationCookies.delete(ctx.request);
        // The plugin writes a persistent cookie after rotating a managed TOTP
        // session. Write the same opaque token last as a browser-session cookie.
        await setSessionCookie(ctx, rotation, true);
      }
    }
    // Part 74. `/sign-in/email` is the only path here that can fail because a
    // secret was guessed wrong, so it is the only one whose failures count
    // toward a lockout. A rejected sign-up or reset request is not a guess.
    const identifier = attemptedIdentifier(ctx.path, ctx.body);
    if (identifier === undefined || dependencies.lockout === undefined) return;
    if (ctx.path !== "/sign-in/email") return;
    const returned = ctx.context.returned;
    if (isAPIError(returned)) {
      // 401 only. An unverified account answers 403 and a malformed body 400;
      // neither is evidence of guessing, and counting them would let a bad
      // client lock its own user out.
      if (returned.statusCode === 401) await dependencies.lockout.recordFailure(identifier);
      return;
    }
    await dependencies.lockout.recordSuccess(identifier);
  });

  const nottedPasswordResetPlugin = {
    id: "notted-password-reset",
    endpoints: { requestPasswordReset, resetPassword, reauthenticate },
  } as const;

  return betterAuth({
    appName: "Notted",
    secret: authConfig.secret,
    baseURL: authConfig.baseUrl.origin,
    basePath: authConfig.basePath,
    // Part 73. Better Auth 1.6 accepts an async function here and calls it per
    // request. THE STATIC LIST MUST BE RETURNED BY THE FUNCTION TOO — supplying
    // a function REPLACES the array rather than extending it, so returning only
    // the verified origins would silently un-trust APP_URL.
    //
    // A resolution failure degrades to the static list rather than throwing:
    // an auth request on the primary host must not fail because the
    // custom-domain table was briefly unreadable.
    trustedOrigins: async (): Promise<string[]> => {
      const verified =
        dependencies.verifiedHosts === undefined
          ? []
          : await dependencies.verifiedHosts.verifiedOriginsFor(
              appConfig.nodeEnv === "production" ? "https" : "http",
            );
      return [...authConfig.trustedOrigins, ...verified];
    },
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: { ...schema, user: schema.users },
      usePlural: false,
      transaction: true,
    }),
    secondaryStorage: dependencies.redisStorage,
    socialProviders: configuredSocialProviders(authConfig, !features.registrationEnabled),
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        requireLocalEmailVerified: true,
        trustedProviders: [],
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !features.registrationEnabled,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: authConfig.verificationTokenTtlSeconds,
      sendVerificationEmail: async ({ user, url }, request) => {
        const registration =
          request === undefined ? false : new URL(request.url).pathname.endsWith("/sign-up/email");
        await emailProducer.queue({
          recipient: user.email,
          purpose: registration ? "registration_verification" : "verification_resend",
          context: { actionUrl: url },
          expiresAt: new Date(Date.now() + authConfig.verificationTokenTtlSeconds * 1_000),
          correlationId: requestCorrelationId(request),
        });
      },
      afterEmailVerification: async (user) => {
        // Registration COMPLETES here: `requireEmailVerification` is on, so this
        // is the first moment the account is usable. Better Auth owns the user
        // INSERT inside its own adapter transaction and exposes no hook into
        // it, so the welcome intent commits atomically with the verification
        // write instead (ADR 0006). The idempotency key is derived from
        // (welcome, address, user), so a re-verification never re-sends.
        await database.transaction(async (tx) => {
          await tx
            .update(users)
            .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
            .where(eq(users.id, user.id));
          await dependencies.workspaceEmailProducer.queue(tx, {
            templateKey: "welcome",
            recipient: user.email,
            workspaceId: null,
            relatedEntityType: "user",
            relatedEntityId: user.id,
          });
        });
      },
    },
    session: {
      // Better Auth 1.6.24 uses this for remembered sessions and hard-codes
      // dontRememberMe sessions to 24 hours. Part 23 supplies the UI choice.
      expiresIn: retention.sessionRememberMeDays * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      freshAge: authConfig.recentAuthenticationSeconds,
      storeSessionInDatabase: true,
      preserveSessionInDatabase: false,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: (nextSession, endpointContext) => {
            const activeSession = endpointContext?.context.session?.session;
            const expiresAt = preserveNonRememberedRotationExpiry(
              endpointContext?.path,
              nextSession,
              activeSession,
            );
            return Promise.resolve(
              expiresAt.getTime() === nextSession.expiresAt.getTime()
                ? undefined
                : { data: { ...nextSession, expiresAt } },
            );
          },
          after: (createdSession, endpointContext) => {
            const active = endpointContext?.context.session;
            if (
              endpointContext?.request !== undefined &&
              endpointContext.path !== undefined &&
              SESSION_ROTATION_PATHS.has(endpointContext.path) &&
              active !== null &&
              active !== undefined &&
              isNonRememberedSession(active.session)
            ) {
              nonRememberedRotationCookies.set(endpointContext.request, {
                session: createdSession,
                user: active.user,
              });
            }
            return Promise.resolve();
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
      window: 60,
      max: appConfig.unauthenticatedRateLimitPerMinute,
      customRules: {
        // Part 74. The four credential paths move to the tighter authentication
        // tier. Better Auth keys these by IP and path only, which is why the
        // per-identifier budget in `AuthLockoutService` exists alongside them.
        "/sign-up/email": { window: 60, max: appConfig.authRateLimitPerMinute },
        "/sign-in/email": { window: 60, max: appConfig.authRateLimitPerMinute },
        "/sign-in/magic-link": { window: 60, max: appConfig.authRateLimitPerMinute },
        "/notted/request-password-reset": {
          window: 60,
          max: appConfig.authRateLimitPerMinute,
        },
        "/send-verification-email": { window: 60, max: appConfig.sensitiveRateLimitPerMinute },
        "/notted/reauthenticate": { window: 60, max: appConfig.sensitiveRateLimitPerMinute },
        "/two-factor/*": { window: 60, max: appConfig.sensitiveRateLimitPerMinute },
        "/passkey/*": { window: 60, max: appConfig.sensitiveRateLimitPerMinute },
      },
    },
    user: BETTER_AUTH_SCHEMA_CONTRACT.user,
    advanced: {
      ...BETTER_AUTH_SCHEMA_CONTRACT.advanced,
      useSecureCookies: appConfig.nodeEnv === "production",
      defaultCookieAttributes: betterAuthCookieAttributes(appConfig.nodeEnv === "production"),
      // Part 74. Better Auth 1.6.24's default IP resolution trusts
      // `x-forwarded-for` unconditionally — a header any client can send — and
      // with no proxy in front of it falls back to a constant, collapsing every
      // caller into one rate-limit bucket. `main.ts` sets this single private
      // header from `request.ip`, which Express derives under the deployment's
      // own `trust proxy` setting, so the value is the one Notted already
      // trusts everywhere else. Naming exactly one header also makes the
      // spoofable ones unreadable to the limiter.
      ipAddress: { ipAddressHeaders: ["x-notted-client-ip"] },
    },
    plugins: [
      magicLink({
        expiresIn: authConfig.magicLinkTokenTtlSeconds,
        allowedAttempts: 1,
        disableSignUp: !features.registrationEnabled,
        storeToken: "hashed",
        rateLimit: { window: 60, max: appConfig.authRateLimitPerMinute },
        sendMagicLink: async ({ email, url }, ctx) => {
          await emailProducer.queue({
            recipient: email,
            purpose: "magic_link",
            context: { actionUrl: url },
            expiresAt: new Date(Date.now() + authConfig.magicLinkTokenTtlSeconds * 1_000),
            correlationId: requestCorrelationId(ctx?.request),
          });
        },
      }),
      twoFactor(twoFactorPluginOptions(authConfig)),
      passkey(passkeyPluginOptions(authConfig)),
      nottedPasswordResetPlugin,
    ],
    disabledPaths: [
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/get-access-token",
      "/refresh-token",
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
      "/passkey/list-user-passkeys",
      ...(!features.emailEnabled
        ? [
            "/sign-up/email",
            "/send-verification-email",
            "/sign-in/magic-link",
            "/magic-link/verify",
            "/notted/request-password-reset",
            "/notted/reset-password",
          ]
        : []),
    ],
    hooks: { before: authBoundaryHook, after: afterHook },
    onAPIError: {
      throw: false,
      onError: () => {
        dependencies.logger.failure({ component: "auth", outcome: "error" }, "Auth request failed");
      },
    },
    // Better Auth/provider errors may carry credential or WebAuthn context in
    // variadic arguments. Route only the generic event above into Notted logs.
    logger: { disabled: true },
    telemetry: { enabled: false },
  }) as unknown as Auth;
}

/**
 * Exact plugin-augmented Better Auth instance type produced by
 * {@link setupBetterAuth}. The explicit {@link Auth} annotation keeps the
 * exported type portable (TS2742) without leaking transitive
 * `@simplewebauthn/server` types into declaration output.
 */
export type BetterAuthInstance = Auth;

export async function createBetterAuthNodeHandler(auth: BetterAuthInstance) {
  const { toNodeHandler } = await import("better-auth/node");
  return toNodeHandler(auth);
}
