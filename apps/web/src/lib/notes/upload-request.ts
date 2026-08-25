/**
 * Multipart image upload with progress (Part 42).
 *
 * **XMLHttpRequest, not `fetch`.** This is the one request in the application
 * that must report *upload* progress, and `fetch` cannot: its request-side
 * streaming (`ReadableStream` bodies with duplex half) is not implemented for
 * multipart uploads across the browsers this product targets, and no `fetch`
 * API exposes bytes-sent at all. `xhr.upload.onprogress` is the only portable
 * source of that number, so the whole file exists to keep XHR contained here
 * instead of leaking it into the manager or a component.
 *
 * Everything else deliberately matches `lib/notes/requests.ts`: the same
 * `NoteRequestResult` envelope, the same status→`kind` mapping, the same
 * `Retry-After` parsing, and the same "only a rate limit or a server fault is
 * worth repeating unchanged" rule, so callers switch on one vocabulary.
 */

import { ATTACHMENT_API_PATHS } from "@notted/shared-types";
import { attachmentUploadResultSchema, uuidSchema } from "@notted/shared-validators";

import type { NoteRequestFailureKind, NoteRequestResult } from "./requests";
import type { AttachmentMedia } from "@notted/shared-types";

import { apiOrigin } from "@/lib/api/api-origin";

/** The multipart part name; mirrors `ATTACHMENT_UPLOAD_FILE_FIELD` on the API. */
export const IMAGE_UPLOAD_FILE_FIELD = "file";

/**
 * Ceiling for one upload attempt. Generous, because a 15 MiB image on a poor
 * connection is a legitimate slow request, but finite so a black-holed
 * connection surfaces as a retryable failure instead of a placeholder that
 * spins forever.
 */
export const IMAGE_UPLOAD_TIMEOUT_MS = 120_000;

export interface UploadProgress {
  readonly loaded: number;
  /** `null` when the browser reports a non-computable length. */
  readonly total: number | null;
  /** `0`–`1`, or `null` when the total is unknown. */
  readonly ratio: number | null;
}

export interface UploadNoteImageRequest {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly file: File;
  /**
   * Reused across **every** retry of the same file. That is the whole point: a
   * retry after a timeout must not be able to create a second attachment for
   * bytes the server already stored.
   */
  readonly idempotencyKey: string;
  readonly onProgress?: (progress: UploadProgress) => void;
  /**
   * Cancels the transfer. An aborted request settles as a non-retryable
   * `unavailable` failure; the caller knows it aborted and ignores the value,
   * which keeps the envelope free of a cancellation vocabulary nothing else
   * would ever switch on.
   */
  readonly signal?: AbortSignal;
}

/** `Retry-After` as milliseconds; identical semantics to `requests.ts`. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.length === 0) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds, 300) * 1_000 : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), 300_000);
}

function conflictKind(body: string): "version-conflict" | "conflict" {
  try {
    const parsed: unknown = JSON.parse(body);
    const top =
      typeof parsed === "object" && parsed !== null && "code" in parsed ? parsed.code : undefined;
    const nested =
      typeof parsed === "object" && parsed !== null && "error" in parsed ? parsed.error : undefined;
    const nestedCode =
      typeof nested === "object" && nested !== null && "code" in nested ? nested.code : undefined;
    if (top === "VERSION_CONFLICT" || nestedCode === "VERSION_CONFLICT") return "version-conflict";
  } catch {
    // A missing or malformed envelope stays a safe generic conflict.
  }
  return "conflict";
}

function failureFor(status: number): NoteRequestFailureKind {
  if (status === 400 || status === 422 || status === 413 || status === 415) return "invalid";
  if (status === 401 || status === 403 || status === 404) return "forbidden-or-not-found";
  return "unavailable";
}

function parseBody(body: string): NoteRequestResult<AttachmentMedia> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, kind: "invalid" };
  }
  const parsed = attachmentUploadResultSchema.safeParse(value);
  return parsed.success
    ? { ok: true, data: parsed.data.attachment }
    : { ok: false, kind: "invalid" };
}

function validIds(...ids: readonly string[]): boolean {
  return ids.every((id) => uuidSchema.safeParse(id).success);
}

/**
 * Upload one image to one note.
 *
 * The `Origin` header is set by the browser and is deliberately **not** set
 * here: `Origin` is a forbidden header name, so `setRequestHeader` would be
 * ignored — which is exactly what makes the server's
 * `assertTrustedMutationOrigin` check meaningful, since a page cannot forge it.
 * `withCredentials` is what carries the session cookie to the API origin.
 */
export function uploadNoteImage(
  request: UploadNoteImageRequest,
): Promise<NoteRequestResult<AttachmentMedia>> {
  const { workspaceId, noteId, file, idempotencyKey, onProgress, signal } = request;
  if (!validIds(workspaceId, noteId) || idempotencyKey.length < 8 || file.size <= 0) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  if (signal?.aborted === true) {
    return Promise.resolve({ ok: false, kind: "unavailable", retryable: false });
  }

  return new Promise<NoteRequestResult<AttachmentMedia>>((resolve) => {
    const url = new URL(ATTACHMENT_API_PATHS.noteCollection(workspaceId, noteId), apiOrigin());
    const xhr = new XMLHttpRequest();
    let settled = false;

    // Only aborts the transfer; the `abort` event below is what settles the
    // promise, so there is exactly one place a cancellation result is produced.
    const abortTransfer = (): void => {
      xhr.abort();
    };

    const finish = (result: NoteRequestResult<AttachmentMedia>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abortTransfer);
      resolve(result);
    };

    xhr.open("POST", url.toString(), true);
    xhr.withCredentials = true;
    xhr.timeout = IMAGE_UPLOAD_TIMEOUT_MS;
    xhr.responseType = "text";
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Idempotency-Key", idempotencyKey);

    if (onProgress !== undefined) {
      xhr.upload.addEventListener("progress", (event) => {
        const total = event.lengthComputable ? event.total : null;
        onProgress({
          loaded: event.loaded,
          total,
          ratio: total === null || total === 0 ? null : Math.min(event.loaded / total, 1),
        });
      });
    }

    xhr.addEventListener("load", () => {
      const status = xhr.status;
      const body = typeof xhr.response === "string" ? xhr.response : "";
      if (status >= 200 && status < 300) {
        finish(parseBody(body));
        return;
      }
      if (status === 409) {
        finish({ ok: false, kind: conflictKind(body) });
        return;
      }
      const kind = failureFor(status);
      if (kind !== "unavailable") {
        finish({ ok: false, kind });
        return;
      }
      finish({
        ok: false,
        kind: "unavailable",
        // Only a rate limit or a server fault is worth repeating unchanged.
        retryable: status === 429 || status >= 500,
        retryAfterMs: retryAfterMs(xhr.getResponseHeader("Retry-After")),
      });
    });

    // Offline, DNS/TLS failure, or the timeout above: transient by nature, so
    // the caller is allowed to repeat them with the same idempotency key.
    xhr.addEventListener("error", () =>
      finish({ ok: false, kind: "unavailable", retryable: true }),
    );
    xhr.addEventListener("timeout", () =>
      finish({ ok: false, kind: "unavailable", retryable: true }),
    );
    xhr.addEventListener("abort", () =>
      finish({ ok: false, kind: "unavailable", retryable: false }),
    );
    signal?.addEventListener("abort", abortTransfer, { once: true });

    const form = new FormData();
    form.append(IMAGE_UPLOAD_FILE_FIELD, file, file.name);
    xhr.send(form);
  });
}
