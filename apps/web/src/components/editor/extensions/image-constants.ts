/**
 * The image node's names and fixed strings.
 *
 * Their own module because `CustomImage.ts`, `image-node-dom.ts` and the toolbar
 * all need them, and a shared leaf is the only way three modules can agree on a
 * class name without one of them importing another for a string. Nothing here
 * imports anything, which is what keeps the split acyclic.
 */

export const IMAGE_EXTENSION_NAME = "image";

/**
 * Raised on `editor.view.dom` when the keyboard asks for the selected image's
 * toolbar. A bubbling `CustomEvent` for the same reason `ATTACHMENT_EVENTS`
 * are: the keymap runs inside ProseMirror, where there is no React prop to
 * thread, and `ImageToolbar` already has the element to listen on.
 */
export const IMAGE_TOOLBAR_REQUEST_EVENT = "notted:image-toolbar";

/** Wrapper painted around the `<img>`; owns the blur-up and aspect ratio. */
export const IMAGE_FRAME_CLASS = "notted-image-frame";
export const IMAGE_FALLBACK_CLASS = "notted-image-fallback";
/** Part 43 chrome. The figure and caption classes come from the contract. */
export const IMAGE_HANDLES_CLASS = "notted-image-handles";
export const IMAGE_HANDLE_CLASS = "notted-image-handle";
export const IMAGE_CAPTION_INPUT_CLASS = "notted-image-caption__input";
export const IMAGE_CAPTION_TEXT_CLASS = "notted-image-caption__text";
export const IMAGE_STATUS_CLASS = "notted-image-status";

export const IMAGE_UNAVAILABLE_TEXT = "This image is unavailable.";
export const IMAGE_LOADING_TEXT = "Loading image…";
export const IMAGE_CAPTION_PLACEHOLDER = "Add a caption";
export const IMAGE_CAPTION_LABEL = "Image caption";
