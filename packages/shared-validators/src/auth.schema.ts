import { z } from "zod";

import { uuidSchema } from "./common.schema";

const emailSchema = z.string().trim().toLowerCase().email().max(255);

export const authPasswordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/[a-z]/u, "Password must include a lowercase letter")
  .regex(/[A-Z]/u, "Password must include an uppercase letter")
  .regex(/[0-9]/u, "Password must include a number")
  .regex(/[^A-Za-z0-9]/u, "Password must include a symbol");

const optionalCallbackUrlSchema = z.string().trim().min(1).max(2_048).optional();

export const oauthProviderIdSchema = z.enum(["google", "github", "microsoft"]);
export type OAuthProviderIdInput = z.infer<typeof oauthProviderIdSchema>;

export const passkeyNameSchema = z.string().trim().min(1).max(64);
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/u, "Enter the six-digit code");
export const recoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/u, "Enter a recovery code");
export const reauthenticateSchema = z.object({ password: z.string().min(1).max(128) }).strict();
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;

export const registerWithPasswordSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    email: emailSchema,
    password: authPasswordSchema,
    callbackURL: optionalCallbackUrlSchema,
  })
  .strict();
export type RegisterWithPasswordInput = z.infer<typeof registerWithPasswordSchema>;

export const signInWithPasswordSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    callbackURL: optionalCallbackUrlSchema,
    rememberMe: z.boolean().optional(),
  })
  .strict();
export type SignInWithPasswordInput = z.infer<typeof signInWithPasswordSchema>;

export const requestEmailVerificationSchema = z
  .object({ email: emailSchema, callbackURL: optionalCallbackUrlSchema })
  .strict();
export type RequestEmailVerificationInput = z.infer<typeof requestEmailVerificationSchema>;

export const requestMagicLinkSchema = z
  .object({
    email: emailSchema,
    callbackURL: optionalCallbackUrlSchema,
    newUserCallbackURL: optionalCallbackUrlSchema,
    errorCallbackURL: optionalCallbackUrlSchema,
  })
  .strict();
export type RequestMagicLinkInput = z.infer<typeof requestMagicLinkSchema>;

export const requestPasswordResetSchema = z.object({ email: emailSchema }).strict();
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z
  .object({ token: z.string().trim().min(32).max(512), newPassword: authPasswordSchema })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

const profileFields = {
  name: z.string().trim().min(1).max(255),
};

/**
 * This is profile metadata, not account creation. Better Auth exclusively owns
 * credentials, provider accounts, verification, sessions, passkeys and 2FA.
 */
export const createUserProfileSchema = z.object(profileFields).strict();
export type CreateUserProfileInput = z.infer<typeof createUserProfileSchema>;

export const updateUserProfileSchema = z
  .object({
    name: profileFields.name.optional(),
  })
  .strict()
  .refine(({ name }) => name !== undefined, {
    message: "At least one profile field is required",
  });
export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;

export const userProfileFilterSchema = z
  .object({
    id: uuidSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type UserProfileFilterInput = z.infer<typeof userProfileFilterSchema>;
