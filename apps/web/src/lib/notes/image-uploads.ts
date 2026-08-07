/**
 * Image upload queue (Part 42) — pure logic, no React and no ProseMirror.
 *
 * It lives in `lib/notes` rather than in `components/editor` on purpose: that
 * placement is what keeps "the editor performs no network I/O" true *by
 * construction* rather than by convention. `components/notes/useImageUploads.ts`
 * is the React adapter, and the editor only ever receives an injected callback.
 *
 * Responsibilities:
 *
 * - client pre-flight against the **same** shared constants the server enforces;
 * - a bounded-concurrency queue, so dropping twenty files does not open twenty
 *   sockets;
 * - one idempotency key per file, reused across every retry, so a retry after a
 *   timeout can never create a second attachment for bytes already stored;
 * - exactly one automatic retry, and only when the failure envelope says the
 *   request is worth repeating unchanged; everything else waits for a person.
 */

import { ATTACHMENT_IMAGE_MIME_TYPES, MAX_IMAGE_UPLOAD_BYTES } from "@notted/shared-validators";

import type { NoteRequestFailure, NoteRequestResult } from "./requests";
import type { UploadProgress } from "./upload-request";
import type { AttachmentMedia } from "@notted/shared-types";

/** Concurrent transfers. Three keeps a batch fast without starving the app. */
export const MAX_CONCURRENT_IMAGE_UPLOADS = 3;

/** Automatic attempts beyond the first, for retryable failures only. */
export const AUTOMATIC_RETRY_LIMIT = 1;

export type ImageUploadStatus = "queued" | "uploading" | "error" | "done" | "cancelled";

/**
 * Which flow a queued transfer belongs to (Part 44).
 *
 * The queue is **shared rather than duplicated**: bounded concurrency, one
 * idempotency key per file reused across retries, the single automatic retry,
 * cancellation, and orphan cleanup are all identical requirements for an image
 * and for a PDF, and a second copy of them would be a second set of bugs. The
 * three things that genuinely differ — which pre-flight bounds apply, which
 * endpoint the bytes go to, and which node type completion inserts — are
 * carried by this discriminator and resolved by the caller, not by the queue.
 */
export type UploadKind = "image" | "file";

export interface ImageUploadItem {
  /** Temporary id. Identifies the placeholder decoration, never the document. */
  readonly id: string;
  /** Which flow this transfer belongs to. Chosen at `enqueue`, never changes. */
  readonly kind: UploadKind;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly status: ImageUploadStatus;
  /** `0`–`1`, or `null` while the transfer length is unknown. */
  readonly progress: number | null;
  /** Human-readable state, written for a screen reader as much as for the eye. */
  readonly message: string;
  /** Whether offering a Retry button would be honest. */
  readonly retryable: boolean;
  readonly attempts: number;
}

export type ImageUploadEvent =
  | { readonly kind: "queued"; readonly item: ImageUploadItem }
  | { readonly kind: "progress"; readonly item: ImageUploadItem }
  | {
      readonly kind: "uploaded";
      readonly item: ImageUploadItem;
      readonly attachment: AttachmentMedia;
    }
  | { readonly kind: "failed"; readonly item: ImageUploadItem }
  | { readonly kind: "removed"; readonly item: ImageUploadItem }
  /**
   * The transfer finished successfully but the writer had already cancelled, so
   * nothing will ever reference the row. The adapter deletes it rather than
   * leaving an orphan the writer never asked for.
   */
  | { readonly kind: "orphaned"; readonly attachment: AttachmentMedia };

export interface ImageUploadTarget {
  readonly workspaceId: string;
  readonly noteId: string;
}

export interface ImageUploadCall extends ImageUploadTarget {
  readonly file: File;
  /** Routes the bytes to the image or the generic-file endpoint. */
  readonly kind: UploadKind;
  readonly idempotencyKey: string;
  readonly onProgress: (progress: UploadProgress) => void;
  readonly signal: AbortSignal;
}

export interface ImageUploadManagerOptions {
  readonly upload: (call: ImageUploadCall) => Promise<NoteRequestResult<AttachmentMedia>>;
  readonly onEvent: (event: ImageUploadEvent) => void;
  readonly concurrency?: number;
  /** Injected so tests get deterministic ids and keys. */
  readonly createId?: () => string;
  /**
   * Client pre-flight, injected rather than branched on inside the queue.
   *
   * `image-uploads.ts` therefore never imports the attachment bounds, which
   * keeps the module dependency one-directional (`attachment-uploads` → this
   * file, never the reverse) and lets a test substitute a check without
   * fabricating `File` objects that satisfy a real MIME allow-list.
   */
  readonly check?: (file: File, kind: UploadKind) => ImageFileCheck;
}

export interface ImageUploadManager {
  enqueue(
    target: ImageUploadTarget,
    files: readonly File[],
    kind?: UploadKind,
  ): readonly ImageUploadItem[];
  retry(id: string): void;
  cancel(id: string): void;
  /** Drop a terminal item (an error the writer has read and accepted). */
  dismiss(id: string): void;
  cancelAll(): void;
  snapshot(): readonly ImageUploadItem[];
  subscribe(listener: (items: readonly ImageUploadItem[]) => void): () => void;
}

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(ATTACHMENT_IMAGE_MIME_TYPES);

export type ImageFileRejection = "type" | "size" | "empty";

export type ImageFileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ImageFileRejection; readonly message: string };

function fileLabel(file: File): string {
  return file.name.length > 0 ? file.name : "This file";
}

/**
 * Client pre-flight, using the **same constants the server enforces**
 * (`ATTACHMENT_IMAGE_MIME_TYPES`, `MAX_IMAGE_UPLOAD_BYTES`) so the two bounds
 * cannot drift apart. It is a courtesy that gives instant feedback, never a
 * control: the server re-sniffs the magic bytes and re-measures the length on
 * every upload regardless (Part 40), because a browser check is bypassable.
 */
export function checkImageFile(file: File): ImageFileCheck {
  if (!IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
    return {
      ok: false,
      reason: "type",
      message: `${fileLabel(file)} is not a supported image type.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, reason: "empty", message: `${fileLabel(file)} is empty.` };
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    const limitMb = Math.floor(MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024));
    return {
      ok: false,
      reason: "size",
      message: `${fileLabel(file)} is larger than the ${limitMb} MB image limit.`,
    };
  }
  return { ok: true };
}

/**
 * The alt text a freshly uploaded image starts with.
 *
 * A filename is a *weak* text alternative — nobody writes `IMG_4821` for a
 * reader — but it is author-supplied text about this specific image, and it is
 * strictly better than the two alternatives: `alt=""` would silently declare a
 * meaningful image decorative, and inventing a description would be a lie. Part
 * 43 adds the editor that lets an author replace or clear it, at which point an
 * explicit `""` genuinely means "decorative".
 *
 * The extension is dropped and separators become spaces, so `holiday_photo.png`
 * reads as `holiday photo` rather than as a path fragment. Bounded to
 * `maxImageAlt`, and control characters are stripped, because a filename is
 * untrusted input.
 */
export function defaultImageAlt(fileName: string, maxLength = 500): string {
  const withoutExtension = fileName.replace(/\.[a-z0-9]{1,10}$/iu, "");
  return (
    withoutExtension
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/[_-]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maxLength)
  );
}

/** User-facing copy for a failed upload, written from the stable failure kind. */
export function uploadFailureMessage(
  fileName: string,
  failure: NoteRequestFailure,
  kind: UploadKind = "image",
): string {
  const noun = kind === "file" ? "file" : "image";
  const label = fileName.length > 0 ? fileName : `This ${noun}`;
  switch (failure.kind) {
    case "invalid":
      return `${label} was rejected as an unsupported or oversized ${noun}.`;
    case "forbidden-or-not-found":
      return `You do not have permission to add ${noun}s to this note, so ${label} was not uploaded.`;
    case "version-conflict":
    case "conflict":
      return `${label} could not be added because this note changed elsewhere.`;
    case "unavailable":
    default:
      return failure.retryable === true
        ? `${label} could not be uploaded. You may be offline; try again.`
        : `${label} could not be uploaded.`;
  }
}

interface UploadTask {
  readonly id: string;
  readonly file: File;
  readonly kind: UploadKind;
  readonly idempotencyKey: string;
  readonly target: ImageUploadTarget;
  item: ImageUploadItem;
  controller: AbortController | null;
  cancelled: boolean;
  automaticRetries: number;
}

function randomId(): string {
  const runtime = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof runtime?.randomUUID === "function") return runtime.randomUUID();
  // Never used for security; only to key a placeholder and an idempotency scope.
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createImageUploadManager(options: ImageUploadManagerOptions): ImageUploadManager {
  const concurrency = Math.max(1, options.concurrency ?? MAX_CONCURRENT_IMAGE_UPLOADS);
  const createId = options.createId ?? randomId;
  const check = options.check ?? ((file: File): ImageFileCheck => checkImageFile(file));
  const tasks = new Map<string, UploadTask>();
  const order: string[] = [];
  const listeners = new Set<(items: readonly ImageUploadItem[]) => void>();
  let active = 0;

  const snapshot = (): readonly ImageUploadItem[] =>
    order.flatMap((id) => {
      const task = tasks.get(id);
      return task === undefined ? [] : [task.item];
    });

  const notify = (): void => {
    const items = snapshot();
    for (const listener of listeners) listener(items);
  };

  const emit = (event: ImageUploadEvent): void => {
    options.onEvent(event);
    notify();
  };

  const patch = (task: UploadTask, changes: Partial<ImageUploadItem>): ImageUploadItem => {
    task.item = { ...task.item, ...changes };
    return task.item;
  };

  const remove = (task: UploadTask): void => {
    tasks.delete(task.id);
    const index = order.indexOf(task.id);
    if (index !== -1) order.splice(index, 1);
  };

  const pump = (): void => {
    for (const id of order) {
      if (active >= concurrency) return;
      const task = tasks.get(id);
      if (task === undefined || task.item.status !== "queued" || task.cancelled) continue;
      void start(task);
    }
  };

  const settle = (task: UploadTask, result: NoteRequestResult<AttachmentMedia>): void => {
    active -= 1;
    task.controller = null;

    if (task.cancelled) {
      // The bytes may still have landed: the server has no way to know the
      // writer changed their mind mid-transfer. A successful result here is an
      // attachment nothing will ever reference, so the adapter deletes it.
      if (result.ok) options.onEvent({ kind: "orphaned", attachment: result.data });
      pump();
      return;
    }

    if (result.ok) {
      const item = patch(task, {
        status: "done",
        progress: 1,
        message: `${task.item.fileName} uploaded.`,
        retryable: false,
      });
      emit({ kind: "uploaded", item, attachment: result.data });
      remove(task);
      notify();
      pump();
      return;
    }

    const retryable = result.retryable === true;
    if (retryable && task.automaticRetries < AUTOMATIC_RETRY_LIMIT) {
      task.automaticRetries += 1;
      patch(task, {
        status: "queued",
        progress: null,
        message: `Retrying ${task.item.fileName}…`,
      });
      notify();
      pump();
      return;
    }

    const item = patch(task, {
      status: "error",
      progress: null,
      message: uploadFailureMessage(task.item.fileName, result, task.kind),
      // A rejected file will be rejected identically forever; only a transient
      // failure is worth offering a Retry button for.
      retryable,
    });
    emit({ kind: "failed", item });
    pump();
  };

  const start = async (task: UploadTask): Promise<void> => {
    active += 1;
    const controller = new AbortController();
    task.controller = controller;
    patch(task, {
      status: "uploading",
      progress: 0,
      message: `Uploading ${task.item.fileName}…`,
      attempts: task.item.attempts + 1,
    });
    notify();

    let result: NoteRequestResult<AttachmentMedia>;
    try {
      result = await options.upload({
        workspaceId: task.target.workspaceId,
        noteId: task.target.noteId,
        file: task.file,
        kind: task.kind,
        idempotencyKey: task.idempotencyKey,
        signal: controller.signal,
        onProgress: (progress) => {
          if (task.cancelled || task.item.status !== "uploading") return;
          const item = patch(task, { progress: progress.ratio });
          emit({ kind: "progress", item });
        },
      });
    } catch {
      // An upload implementation is not supposed to throw; treat one that does
      // as a transient failure rather than losing the task in limbo.
      result = { ok: false, kind: "unavailable", retryable: true };
    }
    settle(task, result);
  };

  return {
    enqueue: (target, files, kind = "image") => {
      const created: ImageUploadItem[] = [];
      for (const file of files) {
        const id = createId();
        const verdict = check(file, kind);
        const base: ImageUploadItem = {
          id,
          kind,
          fileName:
            file.name.length > 0 ? file.name : kind === "file" ? "Untitled file" : "Untitled image",
          sizeBytes: file.size,
          status: verdict.ok ? "queued" : "error",
          progress: null,
          message: verdict.ok ? `${file.name} is waiting to upload.` : verdict.message,
          // A file the shared bounds already reject would be rejected
          // identically on every retry, so no Retry is offered for it.
          retryable: false,
          attempts: 0,
        };
        const task: UploadTask = {
          id,
          file,
          kind,
          // Created once per file and reused by every retry of that file.
          idempotencyKey: createId(),
          target,
          item: base,
          controller: null,
          cancelled: false,
          automaticRetries: 0,
        };
        tasks.set(id, task);
        order.push(id);
        created.push(base);
        emit(verdict.ok ? { kind: "queued", item: base } : { kind: "failed", item: base });
      }
      pump();
      return created;
    },

    retry: (id) => {
      const task = tasks.get(id);
      if (task === undefined || task.item.status !== "error" || !task.item.retryable) return;
      task.cancelled = false;
      task.automaticRetries = AUTOMATIC_RETRY_LIMIT;
      patch(task, {
        status: "queued",
        progress: null,
        message: `${task.item.fileName} is waiting to upload.`,
      });
      notify();
      pump();
    },

    cancel: (id) => {
      const task = tasks.get(id);
      if (task === undefined) return;
      task.cancelled = true;
      task.controller?.abort();
      const item = patch(task, {
        status: "cancelled",
        progress: null,
        message: `${task.item.fileName} was cancelled.`,
        retryable: false,
      });
      remove(task);
      emit({ kind: "removed", item });
      pump();
    },

    dismiss: (id) => {
      const task = tasks.get(id);
      if (task === undefined) return;
      task.cancelled = true;
      task.controller?.abort();
      remove(task);
      emit({ kind: "removed", item: task.item });
      pump();
    },

    cancelAll: () => {
      for (const id of [...order]) {
        const task = tasks.get(id);
        if (task === undefined) continue;
        task.cancelled = true;
        task.controller?.abort();
        remove(task);
        options.onEvent({ kind: "removed", item: task.item });
      }
      notify();
    },

    snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
