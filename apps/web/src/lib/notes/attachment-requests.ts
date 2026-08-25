/**
 * Attachment metadata reads and the projection the editor renders from
 * (Part 42).
 *
 * Every URL produced here is an **absolute API URL** on
 * `NEXT_PUBLIC_API_URL`, pointing at the authorized streaming endpoint. There
 * are no presigned URLs and no storage hosts anywhere in the frontend: MinIO is
 * unreachable from a browser (ADR 0005), and the proxy re-checks workspace
 * membership on every single request, so a leaked URL grants nothing a leaked
 * session would not already grant.
 *
 * The request helper is written out rather than imported from `requests.ts`
 * because that module's `requestJson` is private to it; the failure vocabulary
 * (`NoteRequestResult`) is shared, which is the part callers switch on.
 */

import { ATTACHMENT_API_PATHS } from "@notted/shared-types";
import {
  attachmentDeleteResultSchema,
  attachmentListResultSchema,
  uuidSchema,
} from "@notted/shared-validators";

import type { NoteRequestResult } from "./requests";
import type { AttachmentEntry } from "@/components/editor/attachment-directory";
import type {
  AttachmentDeleteResult,
  AttachmentListResult,
  AttachmentMedia,
  AttachmentServableVariant,
} from "@notted/shared-types";

import { apiOrigin } from "@/lib/api/api-origin";

const REQUEST_TIMEOUT_MS = 8_000;

/** The rendition an on-screen image loads. See `attachmentEntry`. */
export const DEFAULT_IMAGE_VARIANT: AttachmentServableVariant = "full";

function validIds(...ids: readonly string[]): boolean {
  return ids.every((id) => uuidSchema.safeParse(id).success);
}

type SafeParser<T> = (value: unknown) => { success: true; data: T } | { success: false };

async function requestAttachmentJson<T>(
  path: string,
  init: RequestInit,
  parser: SafeParser<T>,
): Promise<NoteRequestResult<T>> {
  try {
    const response = await fetch(new URL(path, apiOrigin()), {
      ...init,
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) return { ok: false, kind: "invalid" };
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { ok: false, kind: "forbidden-or-not-found" };
      }
      if (response.status === 409) return { ok: false, kind: "conflict" };
      return {
        ok: false,
        kind: "unavailable",
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    const parsed = parser(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    return { ok: false, kind: "unavailable", retryable: true };
  }
}

/** Absolute URL for one servable rendition of one attachment. */
export function attachmentContentUrl(
  workspaceId: string,
  attachmentId: string,
  variant: AttachmentServableVariant = DEFAULT_IMAGE_VARIANT,
): string {
  return new URL(
    ATTACHMENT_API_PATHS.content(workspaceId, attachmentId, variant),
    apiOrigin(),
  ).toString();
}

/**
 * Project authorized attachment metadata onto what the node view renders.
 *
 * The intrinsic size prefers the `full` rendition, because that is the one the
 * node view loads by default: `full` is bounded to 2000 px by the Part 41
 * pipeline, which keeps a zoomed sheet and a printed page sharp, and the paper
 * is only ~800 px wide so the extra bytes buy real fidelity rather than waste.
 * `medium` and `thumbnail` stay addressable for Part 43's sizing work.
 */
export function attachmentEntry(media: AttachmentMedia): AttachmentEntry {
  const full = media.variants.full ?? media.variants.medium ?? media.variants.thumbnail;
  const blur = media.variants.blur;
  return {
    attachmentId: media.id,
    displayName: media.displayName,
    status: media.status,
    // Part 44. Carried straight from the authorized projection so the card shows
    // what the DATABASE says, not what the document node cached at insertion.
    mediaType: media.mediaType,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    createdAt: media.createdAt,
    contentUrl: attachmentContentUrl(media.workspaceId, media.id, DEFAULT_IMAGE_VARIANT),
    width: full?.width ?? media.width,
    height: full?.height ?? media.height,
    blurDataUri: blur === undefined ? null : blur.dataUri,
    sources: {
      full: attachmentContentUrl(media.workspaceId, media.id, "full"),
      medium: attachmentContentUrl(media.workspaceId, media.id, "medium"),
      thumbnail: attachmentContentUrl(media.workspaceId, media.id, "thumbnail"),
    },
  };
}

/** Every attachment on one note, used to hydrate stored image nodes on open. */
export function requestNoteAttachments(
  workspaceId: string,
  noteId: string,
): Promise<NoteRequestResult<AttachmentListResult>> {
  if (!validIds(workspaceId, noteId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestAttachmentJson(
    ATTACHMENT_API_PATHS.noteCollection(workspaceId, noteId),
    {},
    (value) => attachmentListResultSchema.safeParse(value),
  );
}

/**
 * Delete one attachment.
 *
 * Used only for the narrow case where an upload is cancelled *after* the server
 * already created the row: the bytes exist, nothing references them, and leaving
 * them behind would be an orphan the writer never asked for. It is best-effort —
 * a failure here is not surfaced, because the user's cancellation already
 * succeeded from their point of view.
 */
export function deleteAttachment(
  workspaceId: string,
  attachmentId: string,
): Promise<NoteRequestResult<AttachmentDeleteResult>> {
  if (!validIds(workspaceId, attachmentId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestAttachmentJson(
    ATTACHMENT_API_PATHS.detail(workspaceId, attachmentId),
    { method: "DELETE" },
    (value) => attachmentDeleteResultSchema.safeParse(value),
  );
}

/** Hydrate a directory from a list response. */
export function attachmentEntries(result: AttachmentListResult): readonly AttachmentEntry[] {
  return result.items.map(attachmentEntry);
}
