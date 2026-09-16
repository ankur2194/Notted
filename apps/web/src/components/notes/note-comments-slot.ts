/**
 * DOM id of the sidebar container `NoteDetailView` renders next to the page.
 *
 * `NoteComments` portals into this element when it is present, so the panel
 * sits in the layout's right column instead of inline below the page content.
 * A render with no matching element in the document (the component's own
 * unit tests, which mount it standalone) falls back to rendering in place.
 */
export const NOTE_COMMENTS_SLOT_ID = "note-comments-slot";
