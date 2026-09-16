/**
 * DOM id of the slot `NoteDetailView` renders in its header, next to Share and
 * Export.
 *
 * `NoteEditorSurface` portals the collaboration status row (`PresenceBar` plus
 * its restore/reconnect notice) into this element when it is present, so
 * "Reconnecting" and friends sit with the other note-level actions instead of
 * inside the scaled paper. A render with no matching element — this
 * component's own standalone unit tests — falls back to rendering in place.
 */
export const PRESENCE_BAR_SLOT_ID = "presence-bar-slot";
