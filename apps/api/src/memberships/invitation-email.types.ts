import { z } from "zod";

export const invitationEmailJobPayloadSchema = z
  .object({ invitationId: z.string().uuid(), deliveryId: z.string().uuid() })
  .strict();

export type InvitationEmailJobPayload = z.infer<typeof invitationEmailJobPayloadSchema>;
