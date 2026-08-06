import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FOCUS_MODE_ATTRIBUTE,
  isFocusModeEnabled,
  setFocusMode,
  subscribeToFocusMode,
  toggleFocusMode,
} from "./focus-mode";

afterEach(() => {
  setFocusMode(false);
});

function attribute(): string | null {
  return document.documentElement.getAttribute(FOCUS_MODE_ATTRIBUTE);
}

describe("focus mode store", () => {
  it("starts disabled with no attribute on the document element", () => {
    expect(isFocusModeEnabled()).toBe(false);
    expect(attribute()).toBeNull();
  });

  it("writes and removes the styling attribute as the state changes", () => {
    expect(setFocusMode(true)).toBe(true);
    expect(isFocusModeEnabled()).toBe(true);
    expect(attribute()).toBe("true");

    expect(setFocusMode(false)).toBe(true);
    expect(isFocusModeEnabled()).toBe(false);
    // Removed, never left as `"false"`: the CSS selects on presence.
    expect(attribute()).toBeNull();
  });

  it("toggles between the two states", () => {
    expect(toggleFocusMode()).toBe(true);
    expect(isFocusModeEnabled()).toBe(true);
    expect(toggleFocusMode()).toBe(true);
    expect(isFocusModeEnabled()).toBe(false);
  });

  it("reports no change for a repeated state but re-asserts the attribute", () => {
    setFocusMode(true);
    document.documentElement.removeAttribute(FOCUS_MODE_ATTRIBUTE);
    expect(setFocusMode(true)).toBe(false);
    expect(attribute()).toBe("true");
  });

  it("notifies subscribers only on a real change and stops after unsubscribing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToFocusMode(listener);

    setFocusMode(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setFocusMode(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setFocusMode(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setFocusMode(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("survives a listener that unsubscribes while being notified", () => {
    const second = vi.fn();
    const unsubscribeFirst = subscribeToFocusMode(() => unsubscribeFirst());
    const unsubscribeSecond = subscribeToFocusMode(second);

    expect(() => setFocusMode(true)).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeSecond();
  });
});
