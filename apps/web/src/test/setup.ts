import "@testing-library/jest-dom";

/**
 * jsdom implements neither `Range.getClientRects` nor `Range.getBoundingClientRect`,
 * which ProseMirror calls whenever it scrolls a selection into view. Without these
 * stubs every editor transaction raises an unhandled `TypeError`. The zero-sized
 * geometry is inert: layout-dependent behavior is verified in Playwright, not jsdom.
 */
function zeroRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function emptyRectList(): DOMRectList {
  return {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* emptyRects() {},
  } as unknown as DOMRectList;
}

if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = emptyRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = zeroRect;
  }
}

/**
 * jsdom does not implement `ClipboardEvent`. ProseMirror's `EditorView.pasteHTML`
 * constructs one purely to hand to `handlePaste` plugins; nothing in the paste
 * path reads `clipboardData` from it, so an inert `Event` subclass is enough to
 * exercise the real clipboard parsing and schema-filtering code. Clipboard data
 * transfer itself is only verifiable in a real browser.
 */
if (typeof globalThis.ClipboardEvent === "undefined") {
  class ClipboardEventStub extends Event {
    public readonly clipboardData: DataTransfer | null = null;
  }
  Object.defineProperty(globalThis, "ClipboardEvent", {
    configurable: true,
    writable: true,
    value: ClipboardEventStub,
  });
}
