// Part 40: route-scoped multipart parsing with byte limits enforced BEFORE and
// DURING transfer (ADR 0005).
//
// `main.ts` registers only `json()` and `urlencoded()`; both skip a
// non-matching `Content-Type`, so a `multipart/form-data` request arrives here
// with its stream unread. A GLOBAL multipart parser is deliberately NOT
// installed — it would change the parsing behavior of every existing route.
//
// busboy, not multer: multer buffers (or spools to disk) and exposes no
// per-chunk hook, so the earliest it can reject an oversize body is after the
// whole part has been accepted. busboy — which multer wraps internally — hands
// us the raw part stream, so we can count bytes as they arrive and destroy the
// connection the moment the cap is crossed. That is what makes a lying or
// absent `Content-Length` non-exploitable.
//
// Buffering in memory is deliberate for images: sniffing needs the head and
// Part 41's Sharp pipeline needs the whole buffer. The relevant ceiling is
// therefore the image ceiling (15 MiB), not the 50 MiB generic upload ceiling.
// Streaming large generic files to a temporary file is Part 44's problem.

import { HttpStatus } from "@nestjs/common";
import busboy from "busboy";

import { ApiHttpException } from "../common/errors/api-http.exception";

import type { Readable } from "node:stream";

/** Slack allowed for multipart boundaries, part headers, and trailing CRLF. */
export const MULTIPART_OVERHEAD_BYTES = 16 * 1_024;

/** Wall-clock ceiling. Image processing is synchronous, so a slowloris upload
 * would otherwise hold a request slot for the whole socket timeout. */
export const MULTIPART_TIMEOUT_MS = 30_000;

const MAX_FIELD_VALUE_BYTES = 1_024;

/** Minimal request shape; `express.Request` satisfies it structurally. */
export interface MultipartRequest extends Readable {
  readonly headers: NodeJS.Dict<string | string[]>;
}

export interface ParseSingleFileUploadOptions {
  readonly maxBytes: number;
  /** Name of the multipart part carrying the binary payload. */
  readonly fileField: string;
  /** Non-file field names that are retained; anything else is discarded. */
  readonly fieldNames: readonly string[];
  readonly timeoutMs?: number;
}

export interface ParsedSingleFileUpload {
  readonly buffer: Buffer;
  /** UNTRUSTED. Read for diagnostics only; the sniffed type is authoritative. */
  readonly declaredMimeType: string;
  /** UNTRUSTED. Sanitized separately before it is persisted for display. */
  readonly declaredFilename: string;
  readonly fields: Readonly<Record<string, string>>;
}

function badRequest(message: string): ApiHttpException {
  return new ApiHttpException(HttpStatus.BAD_REQUEST, { code: "VALIDATION_ERROR", message });
}

function tooLarge(): ApiHttpException {
  return new ApiHttpException(HttpStatus.PAYLOAD_TOO_LARGE, {
    code: "PAYLOAD_TOO_LARGE",
    message: "The uploaded file is larger than the allowed size.",
  });
}

function headerValue(request: MultipartRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseSingleFileUpload(
  request: MultipartRequest,
  options: ParseSingleFileUploadOptions,
): Promise<ParsedSingleFileUpload> {
  const contentType = headerValue(request, "content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Promise.reject(
      new ApiHttpException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The upload must be sent as multipart/form-data.",
      }),
    );
  }

  // BEFORE transfer: a declared length over the cap is refused without reading
  // a single byte off the socket.
  const declaredLength = Number(headerValue(request, "content-length") ?? Number.NaN);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > options.maxBytes + MULTIPART_OVERHEAD_BYTES
  ) {
    return Promise.reject(tooLarge());
  }

  return new Promise<ParsedSingleFileUpload>((resolve, reject) => {
    const allowedFields = new Set(options.fieldNames);
    const fields: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let received = 0;
    let fileSeen = false;
    let declaredMimeType = "";
    let declaredFilename = "";
    let settled = false;

    const parser = busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 1,
        fields: 4,
        fieldSize: MAX_FIELD_VALUE_BYTES,
        parts: 8,
        headerPairs: 32,
        fileSize: options.maxBytes,
      },
    });

    const timer = setTimeout(() => {
      fail(
        new ApiHttpException(HttpStatus.REQUEST_TIMEOUT, {
          code: "REQUEST_FAILED",
          message: "The upload did not complete in time.",
        }),
      );
    }, options.timeoutMs ?? MULTIPART_TIMEOUT_MS);

    function teardown(): void {
      clearTimeout(timer);
      request.unpipe(parser);
      parser.removeAllListeners();
      request.destroy();
    }

    function fail(error: ApiHttpException): void {
      if (settled) return;
      settled = true;
      teardown();
      reject(error);
    }

    function succeed(value: ParsedSingleFileUpload): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    parser.on("file", (name, stream, info) => {
      if (name !== options.fileField) {
        stream.resume();
        fail(badRequest("The upload contains an unexpected file field."));
        return;
      }
      fileSeen = true;
      declaredMimeType = info.mimeType;
      declaredFilename = info.filename ?? "";
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // DURING transfer: this fires on every chunk, so it catches an absent or
        // dishonest `Content-Length` that busboy's own `limit` event would only
        // report after the crossing chunk was already accepted.
        if (received > options.maxBytes) {
          stream.destroy();
          fail(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      stream.on("limit", () => {
        fail(tooLarge());
      });
      stream.on("error", () => {
        fail(badRequest("The upload stream failed."));
      });
    });

    parser.on("field", (name, value) => {
      if (allowedFields.has(name)) fields[name] = value;
    });
    parser.on("filesLimit", () => {
      fail(badRequest("Only one file may be uploaded per request."));
    });
    parser.on("fieldsLimit", () => {
      fail(badRequest("The upload contains too many fields."));
    });
    parser.on("partsLimit", () => {
      fail(badRequest("The upload contains too many parts."));
    });
    parser.on("error", () => {
      fail(badRequest("The upload could not be parsed."));
    });
    parser.on("close", () => {
      if (!fileSeen) {
        fail(badRequest("The upload did not include a file."));
        return;
      }
      succeed(
        Object.freeze({
          buffer: Buffer.concat(chunks, received),
          declaredMimeType,
          declaredFilename,
          fields: Object.freeze({ ...fields }),
        }),
      );
    });
    request.on("error", () => {
      fail(badRequest("The upload connection failed."));
    });

    request.pipe(parser);
  });
}
