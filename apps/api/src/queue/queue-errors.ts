/** Safe, bounded reason codes are persisted and sent to the identifier-only DLQ. */
export type QueueFailureCode =
  | "envelope_invalid"
  | "handler_failed"
  | "handler_missing"
  | "intent_invalid"
  | "payload_hash_mismatch"
  | "payload_invalid"
  | "processor_timeout"
  | "reconciliation_required"
  | "route_invalid"
  | "version_unsupported";

/** Concrete handlers may use this to stop retries without exposing provider errors. */
export class PermanentQueueJobError extends Error {
  constructor(readonly reasonCode: QueueFailureCode = "handler_failed") {
    super("Permanent queue job failure");
    this.name = "PermanentQueueJobError";
  }
}

export class QueueRuntimeError extends Error {
  constructor(
    readonly reasonCode: QueueFailureCode,
    readonly permanent: boolean,
  ) {
    super("Queue job processing failed");
    this.name = "QueueRuntimeError";
  }
}
