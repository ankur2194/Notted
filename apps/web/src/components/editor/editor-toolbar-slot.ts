/**
 * DOM id of the thin, full-width bar `PageContainer` renders above the paper,
 * outside the scaled `.notted-page-paper` subtree.
 *
 * `TiptapEditor` portals its formatting toolbar into this element when it is
 * present, so the toolbar is never squeezed to the physical page's content
 * width. A render with no matching element in the document (this editor's own
 * unit tests, which mount it standalone) falls back to rendering in place.
 */
export const EDITOR_TOOLBAR_SLOT_ID = "editor-toolbar-slot";
