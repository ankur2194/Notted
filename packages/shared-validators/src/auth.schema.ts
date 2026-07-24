import { z } from "zod";

import { uuidSchema } from "./common.schema";

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
