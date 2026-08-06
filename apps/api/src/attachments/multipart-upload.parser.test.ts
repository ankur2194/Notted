import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";

import {
  MULTIPART_OVERHEAD_BYTES,
  parseSingleFileUpload,
  type MultipartRequest,
} from "./multipart-upload.parser";

const BOUNDARY = "----nottedtestboundary";

interface FakeRequestOptions {
  readonly contentType?: string;
  readonly contentLength?: string;
  readonly observeData?: () => void;
}

function fakeRequest(body: Buffer, options: FakeRequestOptions = {}): MultipartRequest {
  const stream = new Readable({
    read() {
      // Push in small slices so a mid-stream abort is observable.
      const size = 4_096;
      for (let offset = 0; offset < body.length; offset += size) {
        options.observeData?.();
        this.push(body.subarray(offset, offset + size));
      }
      this.push(null);
    },
  }) as Readable & { headers: NodeJS.Dict<string | string[]> };
  stream.headers = {
    "content-type": options.contentType ?? `multipart/form-data; boundary=${BOUNDARY}`,
    ...(options.contentLength === undefined ? {} : { "content-length": options.contentLength }),
  };
  return stream;
}

function filePart(field: string, filename: string, type: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      "utf8",
    ),
    bytes,
    Buffer.from("\r\n", "utf8"),
  ]);
}

function textPart(field: string, value: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`,
    "utf8",
  );
}

function body(...parts: readonly Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`, "utf8")]);
}

const options = { maxBytes: 64 * 1_024, fileField: "file", fieldNames: ["noteId"] } as const;

async function statusOf(work: Promise<unknown>): Promise<number> {
  try {
    await work;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error.getStatus();
    throw error;
  }
  throw new Error("expected the upload to be rejected");
}

describe("parseSingleFileUpload", () => {
  it("resolves the buffer plus the untrusted declared metadata and allowed fields", async () => {
    const bytes = Buffer.from("hello world image bytes", "utf8");
    const request = fakeRequest(
      body(
        filePart("file", "photo.png", "image/png", bytes),
        textPart("noteId", "n-1"),
        textPart("ignored", "x"),
      ),
    );
    const result = await parseSingleFileUpload(request, options);
    expect(result.buffer.equals(bytes)).toBe(true);
    expect(result.declaredMimeType).toBe("image/png");
    expect(result.declaredFilename).toBe("photo.png");
    expect(result.fields).toEqual({ noteId: "n-1" });
  });

  it("rejects an oversize Content-Length before reading a single byte", async () => {
    const observeData = vi.fn();
    const request = fakeRequest(body(filePart("file", "a.png", "image/png", Buffer.alloc(16))), {
      contentLength: String(options.maxBytes + MULTIPART_OVERHEAD_BYTES + 1),
      observeData,
    });
    await expect(parseSingleFileUpload(request, options)).rejects.toMatchObject({
      safeResponse: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(observeData).not.toHaveBeenCalled();
  });

  it("rejects mid-stream when Content-Length lies or is absent", async () => {
    const oversize = Buffer.alloc(options.maxBytes + 8_192, 0x41);
    for (const contentLength of [undefined, "10"]) {
      const request = fakeRequest(body(filePart("file", "a.png", "image/png", oversize)), {
        contentLength,
      });
      await expect(parseSingleFileUpload(request, options)).rejects.toMatchObject({
        safeResponse: { code: "PAYLOAD_TOO_LARGE" },
      });
    }
  });

  it("rejects more than one file part", async () => {
    const request = fakeRequest(
      body(
        filePart("file", "a.png", "image/png", Buffer.alloc(8)),
        filePart("file", "b.png", "image/png", Buffer.alloc(8)),
      ),
    );
    await expect(parseSingleFileUpload(request, options)).rejects.toMatchObject({
      safeResponse: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects a file sent under an unexpected field name", async () => {
    const request = fakeRequest(body(filePart("avatar", "a.png", "image/png", Buffer.alloc(8))));
    await expect(parseSingleFileUpload(request, options)).rejects.toMatchObject({
      safeResponse: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects a request with no file part at all", async () => {
    const request = fakeRequest(body(textPart("noteId", "n-1")));
    await expect(parseSingleFileUpload(request, options)).rejects.toMatchObject({
      safeResponse: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects a non-multipart content type with 415", async () => {
    const request = fakeRequest(Buffer.from("{}", "utf8"), { contentType: "application/json" });
    await expect(parseSingleFileUpload(request, options)).rejects.toMatchObject({
      safeResponse: { code: "UNPROCESSABLE_ENTITY" },
    });
    expect(
      await statusOf(
        parseSingleFileUpload(fakeRequest(Buffer.alloc(0), { contentType: "text/plain" }), options),
      ),
    ).toBe(415);
  });

  it("aborts a stalled upload on the wall-clock guard", async () => {
    const stalled = new Readable({ read() {} }) as Readable & {
      headers: NodeJS.Dict<string | string[]>;
    };
    stalled.headers = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };
    const status = await statusOf(parseSingleFileUpload(stalled, { ...options, timeoutMs: 20 }));
    expect(status).toBe(408);
    expect(stalled.destroyed).toBe(true);
  });
});
