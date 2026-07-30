import { z } from "zod";

export const AUTH_EMAIL_JOB_TYPE = "deliver-auth-email" as const;
export const AUTH_EMAIL_PAYLOAD_VERSION = 1 as const;

export const authEmailJobPayloadSchema = z.object({ intentId: z.string().uuid() }).strict();

export type AuthEmailJobPayload = z.infer<typeof authEmailJobPayloadSchema>;
