/**
 * The web app's single entry point for human-readable byte sizes (Part 44).
 *
 * The implementation lives in `@notted/shared-validators` rather than here,
 * because `renderDocumentHtml` — which runs outside `apps/web` during print and
 * export — has to format the same number for the same attachment card. Two
 * implementations would drift, and the drift would be visible as a note that
 * reads "1.19 MiB" on screen and "1.2 MB" on paper.
 *
 * This module exists so that every consumer inside `apps/web` imports one path:
 * the attachment card, `WorkspaceStorageLimit`, and Part 45's workspace usage
 * display. Do not import the shared package directly for this.
 */

export { exactByteLabel, formatBinaryBytes } from "@notted/shared-validators";
