/** Stable audit verbs written by the attachment application service. */
export const ATTACHMENT_AUDIT_ACTIONS = Object.freeze({
  uploadStarted: "attachment.upload.started",
  uploadCompleted: "attachment.upload.completed",
  uploadFailed: "attachment.upload.failed",
  delete: "attachment.delete",
} as const);

/** Identifier-only domain event names consumed after commit. */
export const ATTACHMENT_DOMAIN_EVENTS = Object.freeze({
  created: "attachment.created",
  deleted: "attachment.deleted",
} as const);

export const ATTACHMENT_AUDIT_ENTITY_TYPE = "attachment" as const;
export const ATTACHMENT_DOMAIN_EVENT_QUEUE = "attachment-domain-events" as const;
export const ATTACHMENT_DOMAIN_EVENT_PAYLOAD_VERSION = 1 as const;
export const ATTACHMENT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX = "attachment-domain:" as const;

export type AttachmentMutation = keyof typeof ATTACHMENT_DOMAIN_EVENTS;

/**
 * Short, stable `processing_error` codes. A raw exception message, an object
 * key, a signed URL, or any byte of user content must never be persisted here
 * or logged (`docs/standards/observability.md`).
 */
export const ATTACHMENT_PROCESSING_ERRORS = Object.freeze({
  unsupportedMediaType: "unsupported_media_type",
  decodeFailed: "decode_failed",
  tooManyPixels: "too_many_pixels",
  unsafeSvg: "unsafe_svg",
  storageUnavailable: "storage_unavailable",
  variantFailed: "variant_failed",
  heicDecodeTimeout: "heic_decode_timeout",
  // --- Part 41 additions. Each names a distinct operator-visible budget so a
  // dashboard can tell "someone uploaded a 500-frame GIF" apart from "someone
  // uploaded a decompression bomb"; collapsing them into `too_many_pixels`
  // would hide which ceiling to tune. ---
  tooManyFrames: "too_many_frames",
  heicTooLarge: "heic_too_large",
  processingTimeout: "processing_timeout",
  /**
   * Part 45. Written by the reconciliation sweep when a `ready` row's primary
   * object is positively absent from storage after the ADR 0005 grace period.
   * The row keeps its metadata (so the loss is visible and attributable) but
   * leaves the `ready` state, which also releases the quota it was holding for
   * bytes that no longer exist.
   */
  storageObjectMissing: "storage_object_missing",
} as const);

export type AttachmentProcessingErrorCode =
  (typeof ATTACHMENT_PROCESSING_ERRORS)[keyof typeof ATTACHMENT_PROCESSING_ERRORS];

/**
 * Which stored variant answers a requested one, in preference order. Part 40
 * materializes only `original`, so every request currently resolves to it;
 * Part 41 fills in the derived renditions and the same table starts selecting
 * them without a code change here.
 */
export const ATTACHMENT_VARIANT_FALLBACKS = Object.freeze({
  thumbnail: Object.freeze(["thumbnail", "medium", "full", "original"] as const),
  medium: Object.freeze(["medium", "full", "original"] as const),
  full: Object.freeze(["full", "medium", "original"] as const),
});

/** The multipart part name carrying the binary payload. */
export const ATTACHMENT_UPLOAD_FILE_FIELD = "file" as const;
