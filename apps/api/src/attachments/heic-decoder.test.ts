import { afterEach, describe, expect, it, vi } from "vitest";

import { garbageBytes, heicFtypHeader } from "../../test/image-fixtures";

import { ATTACHMENT_PROCESSING_ERRORS } from "./attachments.constants";
import {
  decodeHeicToJpeg,
  isHeicDecoderAvailable,
  resetHeicConverter,
  setHeicConverter,
} from "./heic-decoder";
import { ImageProcessingError } from "./image-processing";

const OPTIONS = { maximumBytes: 8 * 1_024 * 1_024, timeoutMs: 200 } as const;

afterEach(() => {
  resetHeicConverter();
});

describe("decodeHeicToJpeg", () => {
  it("reports the real decoder as available and routes a buffer through it", async () => {
    expect(isHeicDecoderAvailable()).toBe(true);

    const stub = vi.fn().mockResolvedValue(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
    setHeicConverter(stub);

    const decoded = await decodeHeicToJpeg(heicFtypHeader(), OPTIONS);

    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(decoded.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]?.[0]).toMatchObject({ format: "JPEG" });
  });

  it("refuses when no decoder is available, so `supports()` can return 415 up front", async () => {
    setHeicConverter(null);
    expect(isHeicDecoderAvailable()).toBe(false);

    await expect(decodeHeicToJpeg(heicFtypHeader(), OPTIONS)).rejects.toMatchObject({
      code: ATTACHMENT_PROCESSING_ERRORS.unsupportedMediaType,
    });
  });

  it("rejects an oversize source BEFORE the decoder is entered", async () => {
    const stub = vi.fn().mockResolvedValue(Uint8Array.from([0xff]));
    setHeicConverter(stub);

    await expect(
      decodeHeicToJpeg(garbageBytes(4_096), { maximumBytes: 1_024, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.heicTooLarge });
    // The whole point of the byte cap: a pure-JS decoder cannot be interrupted,
    // so it must never be started on an oversize input.
    expect(stub).not.toHaveBeenCalled();
  });

  it("bounds a decoder that never returns", async () => {
    setHeicConverter(() => new Promise<Uint8Array>(() => undefined));

    const started = Date.now();
    await expect(
      decodeHeicToJpeg(heicFtypHeader(), { maximumBytes: OPTIONS.maximumBytes, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: ATTACHMENT_PROCESSING_ERRORS.heicDecodeTimeout });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("never leaks a decoder message into the persisted code", async () => {
    setHeicConverter(() =>
      Promise.reject(new Error("libheif: box at offset 0x1f4 in /srv/secret/file.heic")),
    );

    const failure = await decodeHeicToJpeg(heicFtypHeader(), OPTIONS).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ImageProcessingError);
    expect((failure as ImageProcessingError).code).toBe(ATTACHMENT_PROCESSING_ERRORS.decodeFailed);
    expect(JSON.stringify((failure as Error).message)).not.toContain("secret");
  });

  it("rejects non-HEIC bytes through the REAL decoder with a short stable code", async () => {
    await expect(decodeHeicToJpeg(garbageBytes(2_048), OPTIONS)).rejects.toMatchObject({
      code: ATTACHMENT_PROCESSING_ERRORS.decodeFailed,
    });
  });
});
