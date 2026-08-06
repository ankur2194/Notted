import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PAGE_MARGINS, MAX_PAGE_MARGINS } from "./page-geometry";
import {
  DEFAULT_PAGE_PREFERENCES,
  PAGE_PREFERENCES_KEY,
  browserStorage,
  parsePagePreferences,
  readPagePreferences,
  writePagePreferences,
} from "./page-preferences";

/** A minimal in-memory `Storage` slice, so no test touches a real one. */
function memoryStorage(initial: string | null = null) {
  const cell = { value: initial };
  return {
    cell,
    getItem: (key: string): string | null => (key === PAGE_PREFERENCES_KEY ? cell.value : null),
    setItem: (key: string, value: string): void => {
      if (key === PAGE_PREFERENCES_KEY) cell.value = value;
    },
  };
}

describe("page preference validation", () => {
  it("uses the specified defaults when nothing is stored", () => {
    expect(DEFAULT_PAGE_PREFERENCES).toEqual({ zoom: 1, margins: { x: 20, y: 25 } });
    expect(parsePagePreferences(null)).toEqual(DEFAULT_PAGE_PREFERENCES);
    expect(readPagePreferences(memoryStorage())).toEqual(DEFAULT_PAGE_PREFERENCES);
  });

  it("rejects malformed and wrongly-shaped payloads", () => {
    expect(parsePagePreferences("not json at all")).toEqual(DEFAULT_PAGE_PREFERENCES);
    expect(parsePagePreferences("null")).toEqual(DEFAULT_PAGE_PREFERENCES);
    expect(parsePagePreferences('"a string"')).toEqual(DEFAULT_PAGE_PREFERENCES);
    expect(parsePagePreferences("[1,2,3]")).toEqual(DEFAULT_PAGE_PREFERENCES);
    expect(parsePagePreferences("{}")).toEqual(DEFAULT_PAGE_PREFERENCES);
  });

  it("accepts only a published zoom level or fit mode", () => {
    expect(parsePagePreferences('{"zoom":1.25}').zoom).toBe(1.25);
    expect(parsePagePreferences('{"zoom":"fit-width"}').zoom).toBe("fit-width");
    expect(parsePagePreferences('{"zoom":"fit-page"}').zoom).toBe("fit-page");
    // An arbitrary number is rejected rather than clamped: nothing in the
    // application ever writes one, so its presence means the value is untrusted.
    expect(parsePagePreferences('{"zoom":0.63}').zoom).toBe(1);
    expect(parsePagePreferences('{"zoom":9999}').zoom).toBe(1);
    expect(parsePagePreferences('{"zoom":-1}').zoom).toBe(1);
    expect(parsePagePreferences('{"zoom":"125%"}').zoom).toBe(1);
    expect(parsePagePreferences('{"zoom":null}').zoom).toBe(1);
    expect(parsePagePreferences('{"zoom":{"level":1.5}}').zoom).toBe(1);
  });

  it("rejects margins that are absent, mistyped, negative, or absurd", () => {
    expect(parsePagePreferences('{"margins":null}').margins).toEqual(DEFAULT_PAGE_MARGINS);
    expect(parsePagePreferences('{"margins":[10,10]}').margins).toEqual(DEFAULT_PAGE_MARGINS);
    expect(parsePagePreferences('{"margins":"20mm"}').margins).toEqual(DEFAULT_PAGE_MARGINS);
    expect(parsePagePreferences('{"margins":{"x":"20","y":"25"}}').margins).toEqual(
      DEFAULT_PAGE_MARGINS,
    );
    expect(parsePagePreferences('{"margins":{"x":-4,"y":-9}}').margins).toEqual(
      DEFAULT_PAGE_MARGINS,
    );
    // 200mm of side margin would leave no content column on either sheet.
    expect(parsePagePreferences('{"margins":{"x":200,"y":200}}').margins).toEqual(
      DEFAULT_PAGE_MARGINS,
    );
    expect(parsePagePreferences('{"margins":{"x":null,"y":1e309}}').margins).toEqual(
      DEFAULT_PAGE_MARGINS,
    );
  });

  it("keeps a valid axis when only the other one is unusable", () => {
    expect(parsePagePreferences('{"margins":{"x":12,"y":-3}}').margins).toEqual({ x: 12, y: 25 });
    expect(parsePagePreferences('{"margins":{"x":"nope","y":40}}').margins).toEqual({
      x: 20,
      y: 40,
    });
    expect(parsePagePreferences(`{"margins":{"x":${MAX_PAGE_MARGINS.x},"y":0}}`).margins).toEqual({
      x: MAX_PAGE_MARGINS.x,
      y: 0,
    });
  });

  it("ignores extra keys instead of carrying anything else through", () => {
    const parsed = parsePagePreferences(
      '{"zoom":0.75,"margins":{"x":5,"y":5},"noteContent":{"type":"doc"},"noteId":"leak"}',
    );
    expect(parsed).toEqual({ zoom: 0.75, margins: { x: 5, y: 5 } });
  });
});

describe("page preference storage", () => {
  it("round-trips a written preference", () => {
    const storage = memoryStorage();
    writePagePreferences(storage, { zoom: "fit-page", margins: { x: 15, y: 30 } });
    expect(readPagePreferences(storage)).toEqual({ zoom: "fit-page", margins: { x: 15, y: 30 } });
  });

  it("never persists note content, only the two viewing preferences", () => {
    const storage = memoryStorage();
    writePagePreferences(storage, { zoom: 1.5, margins: { x: 10, y: 10 } });
    expect(storage.cell.value).toBe('{"zoom":1.5,"margins":{"x":10,"y":10}}');
  });

  it("normalises on write so nothing persisted reverts on the next read", () => {
    const storage = memoryStorage();
    writePagePreferences(storage, { zoom: 4, margins: { x: 900, y: -3 } });
    // The zoom is not a published level, so it falls back; the margins are
    // clamped into range rather than discarded.
    expect(readPagePreferences(storage)).toEqual({
      zoom: 1,
      margins: { x: MAX_PAGE_MARGINS.x, y: 0 },
    });
  });

  it("is inert without storage, as on the server", () => {
    expect(readPagePreferences(null)).toEqual(DEFAULT_PAGE_PREFERENCES);
    expect(() => writePagePreferences(null, DEFAULT_PAGE_PREFERENCES)).not.toThrow();
  });

  it("survives storage that is blocked or full", () => {
    expect(
      readPagePreferences({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual(DEFAULT_PAGE_PREFERENCES);
    const setItem = vi.fn(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writePagePreferences({ setItem }, DEFAULT_PAGE_PREFERENCES)).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("returns the browser storage only where a window exists", () => {
    // jsdom provides one, so this asserts the accessor itself is safe to call.
    expect(browserStorage()).toBe(window.localStorage);
    try {
      // Models a server render, where the module must still be importable.
      vi.stubGlobal("window", undefined);
      expect(browserStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
