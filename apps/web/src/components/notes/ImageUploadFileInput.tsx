"use client";

import { forwardRef, useImperativeHandle, useRef, type ChangeEvent } from "react";

import { IMAGE_UPLOAD_ACCEPT } from "@/components/editor/image-transfer";

export interface ImageUploadFileInputHandle {
  /** Open the native picker. Called from the `/image` command and the toolbar. */
  open(): void;
}

export interface ImageUploadFileInputProps {
  readonly onFiles: (files: readonly File[]) => void;
  /** Accessible name, used only by assistive technology reading the input. */
  readonly label?: string;
  readonly disabled?: boolean;
  /**
   * The picker's type filter. Defaults to the image list (Part 42); the generic
   * attachment instance passes `ATTACHMENT_UPLOAD_ACCEPT` (Part 44).
   *
   * It is a courtesy filter only. A writer can always defeat it with the
   * picker's "All files" option, and the server re-derives the type from the
   * bytes on every upload regardless.
   */
  readonly accept?: string;
  /**
   * Distinguishes the two mounted instances. Two inputs exist rather than one
   * with a swapped `accept`, so each needs its own stable hook for tests and
   * Playwright.
   */
  readonly testId?: string;
}

/**
 * The hidden multi-select file picker (Part 42).
 *
 * It is owned by the note surface rather than by the editor because a file input
 * is a DOM control with its own lifecycle, and the editor must not grow one.
 * The visible, accessible controls are the toolbar's "Insert image" button and
 * the `/image` command; this input is their mechanism, which is why it carries
 * `aria-hidden` and a negative tab index rather than being a second, unlabelled
 * tab stop announcing itself as "Choose files".
 *
 * `value` is cleared on every change so that picking the *same* file twice in a
 * row still fires `change` — without it the second pick is silently ignored,
 * which reads as a broken button.
 */
export const ImageUploadFileInput = forwardRef<
  ImageUploadFileInputHandle,
  ImageUploadFileInputProps
>(function ImageUploadFileInput(
  {
    onFiles,
    label = "Choose images to upload",
    disabled = false,
    accept = IMAGE_UPLOAD_ACCEPT,
    testId = "note-image-file-input",
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (disabled) return;
        inputRef.current?.click();
      },
    }),
    [disabled],
  );

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files === null ? [] : Array.from(event.target.files);
    // Reset before dispatching: the handler may open the picker again, and a
    // stale value would suppress the next identical selection.
    event.target.value = "";
    if (files.length > 0) onFiles(files);
  };

  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={accept}
      hidden
      tabIndex={-1}
      aria-hidden="true"
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onChange={handleChange}
    />
  );
});
