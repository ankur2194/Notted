/** BullMQ execution lanes. Durable intent remains in PostgreSQL `job_outbox`. */
export const PHYSICAL_QUEUE_NAMES = Object.freeze({
  default: "notted-default",
  export: "notted-export",
  ai: "notted-ai",
  maintenance: "notted-maintenance",
} as const);

export type PhysicalQueueName = (typeof PHYSICAL_QUEUE_NAMES)[keyof typeof PHYSICAL_QUEUE_NAMES];

/** One shared terminal-failure lane. Task 50.2 owns its publisher and processor. */
export const DEAD_LETTER_QUEUE_NAME = "notted-dead-letter" as const;
