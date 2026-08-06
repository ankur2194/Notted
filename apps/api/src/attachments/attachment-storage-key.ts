// Part 40: opaque object-key policy (ADR 0005).
//
//   w/{workspaceId}/a/{attachmentId}/{variant}/{token}{ext}
//
// - `w/` and `a/` are fixed literals so a future key family (`e/` for exports)
//   can never collide with this one.
// - `{workspaceId}` / `{attachmentId}` are lowercase UUIDs, regex-validated
//   before interpolation, giving operators a usable partition.
// - `{variant}` comes from a fixed four-value vocabulary.
// - `{token}` is 32 hex characters of `randomBytes(16)`, generated PER OBJECT.
//   Knowing both UUIDs is therefore not enough to guess a key, and every
//   variant key is immutable: reprocessing writes new keys instead of
//   overwriting, so a cached read can never observe a torn object.
// - `{ext}` is the canonical extension of the SNIFFED type, never the user's.
//   It is operator convenience only and carries no authority.
//
// IMPORTANT: a key is NOT an authorization boundary. `parseAttachmentObjectKey`
// exists ONLY for reconciliation and cleanup tooling (Part 45), which needs to
// attribute a stray object to a workspace. It must never be used to decide
// access; the database record inside its workspace is the sole authority. A
// test in `attachment-storage-key.test.ts` asserts that no file under
// `src/authorization/` imports this module.

import { randomBytes } from "node:crypto";

export const ATTACHMENT_VARIANT_NAMES = Object.freeze([
  "original",
  "full",
  "medium",
  "thumbnail",
] as const);

export type AttachmentObjectVariant = (typeof ATTACHMENT_VARIANT_NAMES)[number];

export const ATTACHMENT_OBJECT_EXTENSIONS = Object.freeze([
  ".jpg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bin",
] as const);

export type AttachmentObjectExtension = (typeof ATTACHMENT_OBJECT_EXTENSIONS)[number];

const OBJECT_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, AttachmentObjectExtension>> =
  Object.freeze({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  });

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

export const ATTACHMENT_OBJECT_KEY_PATTERN =
  /^w\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/a\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/(original|full|medium|thumbnail)\/([\da-f]{32})(\.jpg|\.png|\.gif|\.webp|\.svg|\.bin)$/u;

export interface BuildAttachmentObjectKeyInput {
  readonly workspaceId: string;
  readonly attachmentId: string;
  readonly variant: AttachmentObjectVariant;
  readonly extension: AttachmentObjectExtension;
}

export interface ParsedAttachmentObjectKey {
  readonly workspaceId: string;
  readonly attachmentId: string;
  readonly variant: AttachmentObjectVariant;
  readonly token: string;
  readonly extension: AttachmentObjectExtension;
}

/** Map a stored object's MIME type to its canonical key extension. */
export function attachmentObjectExtension(mimeType: string): AttachmentObjectExtension {
  return OBJECT_EXTENSION_BY_MIME_TYPE[mimeType.toLowerCase()] ?? ".bin";
}

function assertUuid(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`attachment object key requires a UUID ${label}`);
  }
  return normalized;
}

export function buildAttachmentObjectKey(input: BuildAttachmentObjectKeyInput): string {
  const workspaceId = assertUuid(input.workspaceId, "workspaceId");
  const attachmentId = assertUuid(input.attachmentId, "attachmentId");
  if (!ATTACHMENT_VARIANT_NAMES.includes(input.variant)) {
    throw new Error("attachment object key requires a known variant");
  }
  if (!ATTACHMENT_OBJECT_EXTENSIONS.includes(input.extension)) {
    throw new Error("attachment object key requires a known extension");
  }
  const token = randomBytes(16).toString("hex");
  return `w/${workspaceId}/a/${attachmentId}/${input.variant}/${token}${input.extension}`;
}

/**
 * Reconciliation/cleanup helper. Returns `null` when the key does not match the
 * canonical layout. NEVER call this to make an access decision.
 */
export function parseAttachmentObjectKey(key: string): ParsedAttachmentObjectKey | null {
  const match = ATTACHMENT_OBJECT_KEY_PATTERN.exec(key);
  if (match === null) return null;
  const [, workspaceId, attachmentId, variant, token, extension] = match;
  if (
    workspaceId === undefined ||
    attachmentId === undefined ||
    variant === undefined ||
    token === undefined ||
    extension === undefined
  ) {
    return null;
  }
  return Object.freeze({
    workspaceId,
    attachmentId,
    variant: variant as AttachmentObjectVariant,
    token,
    extension: extension as AttachmentObjectExtension,
  });
}
