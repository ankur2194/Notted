import { z } from "zod";

export const outboxRuntimeRowSchema = z.object({
  id: z.string().uuid(),
  queueName: z.string(),
  jobType: z.string(),
  payloadVersion: z.number().int(),
  payload: z.unknown(),
  payloadHash: z.string().regex(/^[a-f\d]{64}$/u),
  idempotencyKey: z.string(),
  status: z.enum(["pending", "dispatching", "dispatched", "completed", "failed", "cancelled"]),
  attemptCount: z.number().int().nonnegative(),
  correlationId: z.string().uuid().nullable(),
});

export type OutboxRuntimeRow = z.infer<typeof outboxRuntimeRowSchema>;

export const deadLetterRecordSchema = z
  .object({
    sourceQueue: z.string(),
    outboxIntentId: z.string().uuid(),
    jobType: z.string(),
    reasonCode: z.string(),
    attempts: z.number().int().positive(),
    failedAt: z.string().datetime(),
    correlationId: z.string().uuid().optional(),
  })
  .strict();

export type DeadLetterRecord = z.infer<typeof deadLetterRecordSchema>;
