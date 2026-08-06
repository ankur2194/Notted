"use client";

import { NOTE_DOCUMENT_LIMITS } from "@notted/shared-validators";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type { ImageUploadFileInputHandle } from "./ImageUploadFileInput";
import type { AttachmentDirectory } from "@/components/editor/attachment-directory";
import type {
  ImageFilePickerHandler,
  ImageFilePickerRequest,
  ImageUploadHandler,
  ImageUploadRequest,
} from "@/components/editor/extensions/CustomImage";
import type {
  ImageInsertionController,
  ImagePlaceholderState,
} from "@/components/editor/extensions/image-upload-placeholder";
import type { ImageUploadItem, ImageUploadManager } from "@/lib/notes/image-uploads";
import type { AttachmentListResult, AttachmentMedia } from "@notted/shared-types";
import type { RefObject } from "react";

import { createObjectUrlRegistry } from "@/components/editor/image-transfer";
import { attachmentEntry, deleteAttachment } from "@/lib/notes/attachment-requests";
import { createImageUploadManager, defaultImageAlt } from "@/lib/notes/image-uploads";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import { uploadNoteImage } from "@/lib/notes/upload-request";

export interface UseImageUploadsOptions {
  readonly workspaceId: string;
  readonly noteId: string;
  /** Populated **before** each swap so an inserted image never flashes empty. */
  readonly directory: AttachmentDirectory;
  /** A read-only note uploads nothing, whatever the DOM is asked to do. */
  readonly editable: boolean;
}

export interface ImageUploadsHandle {
  /** Passed to `TiptapEditor` as `uploadImages` (paste and drop). */
  readonly uploadImages: ImageUploadHandler;
  /** Passed to `TiptapEditor` as `onRequestImageFiles` (slash command, toolbar). */
  readonly requestImageFiles: ImageFilePickerHandler;
  /** Wired to the hidden `<input type="file">`. */
  readonly fileInputRef: RefObject<ImageUploadFileInputHandle | null>;
  readonly handlePickedFiles: (files: readonly File[]) => void;
}

/** A dimension the shared contract will accept, or `null`. Never a guess. */
function storedDimension(value: number | null): number | null {
  if (value === null) return null;
  return Number.isInteger(value) && value > 0 && value <= NOTE_DOCUMENT_LIMITS.maxImageDimension
    ? value
    : null;
}

/**
 * React adapter around the pure upload queue (Part 42).
 *
 * The division of labour is the point:
 *
 * - `lib/notes/image-uploads.ts` owns queueing, retries, and idempotency and
 *   knows nothing about React or ProseMirror;
 * - `components/editor` owns decorations and node rendering and knows nothing
 *   about uploads;
 * - this hook is the only place the two meet, and it is deliberately outside
 *   `components/editor` so the "no network I/O in the editor" rule holds by
 *   construction.
 *
 * ## The autosave invariant
 *
 * A completed upload calls `controller.complete`, which dispatches one ordinary
 * editor transaction. That transaction takes exactly the route a typed character
 * takes — `onUpdate` → `safeParseNoteDocument` → `onDocumentChange` →
 * `useNoteAutosave` → one debounced PATCH carrying `expectedVersion`. **No new
 * save call site exists anywhere in this part.** Three uploads finishing inside
 * the 800 ms debounce therefore produce three transactions and exactly one
 * PATCH, and Part 39's single-version-cell invariant is untouched.
 */
export function useImageUploads({
  workspaceId,
  noteId,
  directory,
  editable,
}: UseImageUploadsOptions): ImageUploadsHandle {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<ImageUploadFileInputHandle | null>(null);
  const pendingPickRef = useRef<ImageFilePickerRequest | null>(null);
  const controllersRef = useRef(new Map<string, ImageInsertionController>());
  const previewsRef = useRef(createObjectUrlRegistry());
  const managerRef = useRef<ImageUploadManager | null>(null);

  // Read at call time so a re-render with a new note never rebuilds the queue
  // mid-transfer.
  const targetRef = useRef({ workspaceId, noteId });
  targetRef.current = { workspaceId, noteId };
  const directoryRef = useRef(directory);
  directoryRef.current = directory;
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const placeholderFor = useCallback(
    (item: ImageUploadItem, manager: ImageUploadManager): ImagePlaceholderState => {
      const inFlight = item.status === "queued" || item.status === "uploading";
      return {
        fileName: item.fileName,
        phase:
          item.status === "error" ? "error" : item.status === "uploading" ? "uploading" : "queued",
        progress: item.progress,
        message: item.message,
        previewUrl: previewsRef.current.get(item.id),
        onCancel: inFlight ? () => manager.cancel(item.id) : undefined,
        // Only offered when repeating the identical request could plausibly
        // succeed; a rejected file would be rejected identically forever.
        onRetry:
          item.status === "error" && item.retryable ? () => manager.retry(item.id) : undefined,
        onDismiss: item.status === "error" ? () => manager.dismiss(item.id) : undefined,
      };
    },
    [],
  );

  const forget = useCallback((id: string): void => {
    controllersRef.current.delete(id);
    previewsRef.current.release(id);
  }, []);

  const cacheAttachment = useCallback(
    (attachment: AttachmentMedia): void => {
      queryClient.setQueryData(
        noteQueryKeys.attachments(attachment.workspaceId, attachment.noteId),
        (previous: AttachmentListResult | undefined): AttachmentListResult => {
          const items = previous?.items ?? [];
          const without = items.filter((item) => item.id !== attachment.id);
          return { items: [...without, attachment] };
        },
      );
    },
    [queryClient],
  );

  if (managerRef.current === null) {
    managerRef.current = createImageUploadManager({
      upload: (call) => uploadNoteImage(call),
      onEvent: (event) => {
        const manager = managerRef.current;
        if (manager === null) return;
        if (event.kind === "orphaned") {
          // The writer cancelled after the bytes had already landed. Nothing
          // will ever reference the row, so it is removed rather than left as
          // an orphan; a failure here is deliberately not surfaced, because the
          // cancellation itself already succeeded.
          void deleteAttachment(event.attachment.workspaceId, event.attachment.id);
          return;
        }

        const controller = controllersRef.current.get(event.item.id);
        if (controller === undefined) return;

        if (event.kind === "removed") {
          // Cancel and dismiss change **no document at all**: the placeholder is
          // a decoration, so removing it produces no transaction the autosave
          // machine can see.
          controller.abandon(event.item.id);
          forget(event.item.id);
          return;
        }

        if (event.kind === "uploaded") {
          const entry = attachmentEntry(event.attachment);
          // Seeded before the swap so the node view has the blur placeholder and
          // the intrinsic size the moment it mounts, and never flashes.
          directoryRef.current.upsert(entry);
          cacheAttachment(event.attachment);
          controller.complete(event.item.id, {
            attachmentId: event.attachment.id,
            alt: defaultImageAlt(event.item.fileName, NOTE_DOCUMENT_LIMITS.maxImageAlt),
            width: storedDimension(entry.width),
            height: storedDimension(entry.height),
          });
          forget(event.item.id);
          return;
        }

        controller.update(event.item.id, placeholderFor(event.item, manager));
      },
    });
  }

  const startUpload = useCallback(
    (files: readonly File[], insertAt: number, controller: ImageInsertionController): void => {
      const manager = managerRef.current;
      if (manager === null || !editableRef.current || files.length === 0) return;
      const items = manager.enqueue(targetRef.current, files);
      items.forEach((item, index) => {
        controllersRef.current.set(item.id, controller);
        const file = files[index];
        if (file !== undefined) previewsRef.current.create(item.id, file);
        // Every placeholder in one batch is anchored at the same position. From
        // here `DecorationSet.map` keeps each one where the writer put it, no
        // matter how much text is typed around them while the transfers run.
        controller.begin(item.id, insertAt, placeholderFor(item, manager));
      });
    },
    [placeholderFor],
  );

  const uploadImages = useCallback(
    (request: ImageUploadRequest): void => {
      startUpload(request.files, request.insertAt, request.controller);
    },
    [startUpload],
  );

  const requestImageFiles = useCallback((request: ImageFilePickerRequest): void => {
    if (!editableRef.current) return;
    // The caret position at the moment the command ran is remembered, because
    // the native dialog resolves long after the command returned.
    pendingPickRef.current = request;
    fileInputRef.current?.open();
  }, []);

  const handlePickedFiles = useCallback(
    (files: readonly File[]): void => {
      const pending = pendingPickRef.current;
      pendingPickRef.current = null;
      if (pending === null) return;
      startUpload(files, pending.insertAt, pending.controller);
    },
    [startUpload],
  );

  useEffect(() => {
    const previews = previewsRef.current;
    const controllers = controllersRef.current;
    return () => {
      // Unmount teardown: abort every transfer, then revoke every object URL.
      // The second of exactly three revoke sites; the registry makes a repeat
      // release a no-op, so the decoration's own `destroy()` is harmless.
      managerRef.current?.cancelAll();
      previews.releaseAll();
      controllers.clear();
    };
  }, []);

  return { uploadImages, requestImageFiles, fileInputRef, handlePickedFiles };
}
