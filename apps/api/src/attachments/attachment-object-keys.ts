// Part 45: the single answer to "which objects does this attachment row own?".
//
// Extracted from `AttachmentsService`'s private `variantKeys` because there is
// now a second caller that must not miss a key: the storage-maintenance sweeps.
// Two implementations would drift the moment a new variant name is introduced,
// and the failure mode of drift is silently stranded bytes that no sweep can
// ever attribute to a row again.
//
// The variant NAME LIST here is the authority. `ATTACHMENT_VARIANT_NAMES` in
// `attachment-storage-key.ts` deliberately excludes `preview` (Part 44's
// generic-file preview is not a key-buildable variant), so this list is a
// superset and must stay one.

import type { AttachmentVariantRecord } from "../database/schema";

/**
 * Every variant slot that can hold a stored object, in a fixed order.
 *
 * `blur` is excluded on purpose: it is an inline data URI in the jsonb record,
 * not an object key.
 */
const OBJECT_BEARING_VARIANTS = Object.freeze([
  "original",
  "full",
  "medium",
  "thumbnail",
  "preview",
] as const);

/**
 * Every object key an attachment row owns, de-duplicated and order-stable.
 *
 * `storageKey` is the row's `storage_key` column. It is accepted separately
 * because a `pending`/`processing`/`failed` row has an empty `variants` record
 * while its original object may already exist — exactly the rows the
 * abandoned-upload sweep exists to clean up. For a `ready` row it duplicates
 * `variants.original.key`, which the de-duplication absorbs.
 */
export function attachmentObjectKeys(
  variants: AttachmentVariantRecord | null,
  storageKey?: string | null,
): readonly string[] {
  const keys = new Set<string>();
  if (typeof storageKey === "string" && storageKey !== "") keys.add(storageKey);
  if (variants !== null) {
    for (const name of OBJECT_BEARING_VARIANTS) {
      const key = variants[name]?.key;
      if (typeof key === "string" && key !== "") keys.add(key);
    }
  }
  return Object.freeze([...keys]);
}
