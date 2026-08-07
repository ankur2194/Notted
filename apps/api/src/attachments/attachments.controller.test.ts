import { Readable, Writable } from "node:stream";

import { RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ATTACHMENT_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import {
  AttachmentsController,
  contentDisposition,
  matchesEtag,
  NoteAttachmentsController,
} from "./attachments.controller";

import type { AttachmentContent, AttachmentsService } from "./attachments.service";
import type { ParsedSingleFileUpload } from "./multipart-upload.parser";
import type { AuthService } from "../auth/auth.service";
import type { Request, Response } from "express";

/**
 * Part 44. The upload route now ROUTES on the sniffed bytes, and that decision
 * is only observable once a body has been parsed — so the busboy parser is
 * stubbed here with a payload the test chooses. Every pre-parse guard (trusted
 * origin, idempotency key, the authorization decorator) still runs unmocked and
 * is still asserted below; only the byte source is replaced.
 */
const parserStub = vi.hoisted(() => ({
  next: null as ParsedSingleFileUpload | null,
}));

vi.mock("./multipart-upload.parser", () => ({
  parseSingleFileUpload: vi.fn(() => {
    if (parserStub.next === null) throw new Error("no multipart payload was staged");
    return Promise.resolve(parserStub.next);
  }),
  MULTIPART_OVERHEAD_BYTES: 16 * 1_024,
  MULTIPART_TIMEOUT_MS: 30_000,
}));

function stageUpload(buffer: Buffer, declaredFilename: string, declaredMimeType = ""): void {
  parserStub.next = Object.freeze({
    buffer,
    declaredMimeType,
    declaredFilename,
    fields: Object.freeze({}),
  });
}

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const noteId = "20000000-0000-4000-8500-000000000002";
const attachmentId = "20000000-0000-4000-8900-000000000001";

function request(
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const value = {
    params,
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
  setAuthPrincipal(value, {
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
  return value;
}

/** A real `Writable` so `stream.pipe(response)` behaves exactly as in Express,
 * wearing the header/status surface the controller uses. */
function fakeResponse() {
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const status = vi.fn(() => response);
  const response = Object.assign(sink, {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    status,
  }) as unknown as Response;
  return { response, headers, chunks, sink, status };
}

function content(overrides: Partial<AttachmentContent> = {}): AttachmentContent {
  return Object.freeze({
    stream: Readable.from([Buffer.from("bytes")]),
    mimeType: "image/jpeg",
    contentLength: 5,
    etag: "abc123",
    filename: "holiday photo.jpg",
    mediaType: "image" as const,
    ...overrides,
  });
}

/** Part 44: a generic-file read result, as the service now reports one. */
function fileContent(overrides: Partial<AttachmentContent> = {}): AttachmentContent {
  return content({
    mimeType: "application/pdf",
    filename: "Quarterly Report.pdf",
    mediaType: "file",
    ...overrides,
  });
}

const trustedOrigin = {
  origin: "https://app.notted.test",
  "idempotency-key": "attachment-upload-000000001",
};

function controllers(service: Partial<AttachmentsService>, origin = vi.fn()) {
  const auth = { assertTrustedMutationOrigin: origin } as unknown as AuthService;
  return {
    attachments: new AttachmentsController(service as AttachmentsService, auth),
    notes: new NoteAttachmentsController(service as AttachmentsService, auth),
    origin,
  };
}

function specOf(handler: unknown): HttpAuthorizationSpec {
  return Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler as object) as HttpAuthorizationSpec;
}

describe("AttachmentsController", () => {
  it("publishes the canonical REST paths shared with the browser client", () => {
    expect(ATTACHMENT_API_PATHS.noteCollection(workspaceId, noteId)).toBe(
      `/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`,
    );
    expect(ATTACHMENT_API_PATHS.detail(workspaceId, attachmentId)).toBe(
      `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}`,
    );
    expect(ATTACHMENT_API_PATHS.content(workspaceId, attachmentId)).toBe(
      `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content`,
    );
    expect(ATTACHMENT_API_PATHS.content(workspaceId, attachmentId, "thumbnail")).toBe(
      `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content?variant=thumbnail`,
    );
    expect(Reflect.getMetadata(PATH_METADATA, AttachmentsController)).toBe(
      "workspaces/:workspaceId/attachments",
    );
    expect(Reflect.getMetadata(PATH_METADATA, NoteAttachmentsController)).toBe(
      "workspaces/:workspaceId/notes/:noteId/attachments",
    );
  });

  it("binds each route to the right action and resource selector", () => {
    const readSpec = specOf(AttachmentsController.prototype.content);
    expect(readSpec.action).toBe("file.read");
    expect(readSpec.resource(request({ workspaceId, attachmentId }))).toEqual({
      kind: "file",
      id: attachmentId,
    });
    expect(specOf(AttachmentsController.prototype.delete).action).toBe("file.delete");
    expect(specOf(NoteAttachmentsController.prototype.list).action).toBe("note.read");

    // The upload guard evaluates the TARGET NOTE before a body byte is read.
    const uploadSpec = specOf(NoteAttachmentsController.prototype.upload);
    expect(uploadSpec.action).toBe("file.upload");
    expect(uploadSpec.resource(request({ workspaceId, noteId }))).toEqual({
      kind: "note",
      id: noteId,
    });
    expect(uploadSpec.workspaceId(request({ workspaceId, noteId }))).toBe(workspaceId);
    expect(Reflect.getMetadata(METHOD_METADATA, NoteAttachmentsController.prototype.upload)).toBe(
      RequestMethod.POST,
    );
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, NoteAttachmentsController.prototype.upload),
    ).toBe(201);
  });

  it("sets every download header, including the CORP override helmet would otherwise block", async () => {
    const readContent = vi.fn().mockResolvedValue(content());
    const { response, headers } = fakeResponse();
    await controllers({ readContent }).attachments.content(
      request({ workspaceId, attachmentId }),
      response,
      {},
    );
    expect(headers.get("content-type")).toBe("image/jpeg");
    expect(headers.get("content-length")).toBe("5");
    expect(headers.get("content-disposition")).toBe(
      `inline; filename="holiday photo.jpg"; filename*=UTF-8''holiday%20photo.jpg`,
    );
    expect(headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(headers.get("cache-control")).not.toContain("public");
    expect(headers.get("etag")).toBe("abc123");
    expect(headers.get("vary")).toBe("Cookie");
    expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(headers.get("accept-ranges")).toBe("none");
    // Part 44 added this to BOTH media types.
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    // `compression()` skips image/* by default; assert no encoding is negotiated
    // so a future middleware change is caught here.
    expect(headers.get("content-encoding")).toBeUndefined();
  });

  it("always serves a generic file as an attachment download, never inline", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["application/pdf", "Quarterly Report.pdf"],
      ["application/zip", "release.zip"],
      ["application/x-7z-compressed", "backup.7z"],
      ["application/gzip", "logs.gz"],
      ["application/rtf", "letter.rtf"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "spec.docx"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "budget.xlsx"],
      // The load-bearing case: an uploaded `.html`, stored as inert text.
      ["text/plain", "payload.html"],
    ];
    for (const [mimeType, filename] of cases) {
      const readContent = vi.fn().mockResolvedValue(fileContent({ mimeType, filename }));
      const { response, headers } = fakeResponse();
      await controllers({ readContent }).attachments.content(
        request({ workspaceId, attachmentId }),
        response,
        {},
      );
      expect(headers.get("content-type")).toBe(mimeType);
      expect(headers.get("content-disposition")).toContain("attachment;");
      expect(headers.get("content-disposition")).not.toContain("inline");
      // The original filename survives the round trip, in both RFC 6266 forms.
      expect(headers.get("content-disposition")).toContain(`filename="${filename}"`);
      expect(headers.get("content-disposition")).toContain(
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      // Every hardening header still applies to a file download.
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(headers.get("cross-origin-resource-policy")).toBe("same-site");
      expect(headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    }
  });

  it("does not apply the image inline allow-list to a generic file", async () => {
    // `text/plain` is not in `ATTACHMENT_INLINE_MIME_TYPES`. Under Part 40's rule
    // that would have been a 415; a generic file is instead served as a download,
    // because the allow-list only governs what may be shown INLINE.
    const readContent = vi.fn().mockResolvedValue(fileContent({ mimeType: "text/plain" }));
    const { response, headers, status } = fakeResponse();
    await controllers({ readContent }).attachments.content(
      request({ workspaceId, attachmentId }),
      response,
      {},
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(headers.get("content-disposition")).toContain("attachment;");
  });

  it("defaults to the full variant and rejects an unknown or extra query parameter", async () => {
    const readContent = vi.fn().mockResolvedValue(content());
    const { response } = fakeResponse();
    await controllers({ readContent }).attachments.content(
      request({ workspaceId, attachmentId }),
      response,
      {},
    );
    expect(readContent).toHaveBeenCalledWith(expect.objectContaining({ variant: "full" }));

    for (const rawQuery of [{ variant: "original" }, { variant: "huge" }, { unexpected: "1" }]) {
      await expect(
        controllers({ readContent }).attachments.content(
          request({ workspaceId, attachmentId }),
          fakeResponse().response,
          rawQuery,
        ),
      ).rejects.toMatchObject({ safeResponse: { code: "VALIDATION_ERROR" } });
    }
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const stream = Readable.from([Buffer.from("bytes")]);
    const readContent = vi.fn().mockResolvedValue(content({ stream }));
    const { response, headers, status, sink } = fakeResponse();
    await controllers({ readContent }).attachments.content(
      request({ workspaceId, attachmentId }, { "if-none-match": '"abc123"' }),
      response,
      {},
    );
    expect(status).toHaveBeenCalledWith(304);
    expect(sink.writableEnded).toBe(true);
    expect(headers.get("etag")).toBe("abc123");
    expect(stream.destroyed).toBe(true);
    // A 304 carries no body, so it must not advertise one. RFC 9110 §15.4.5
    // limits a 304 to validating/metadata headers; a `Content-Length` naming
    // bytes that are never sent can confuse an intermediary.
    expect(headers.get("content-length")).toBeUndefined();
    // The validators a cache still needs ARE present.
    expect(headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("refuses to stream a rendition that is not browser-safe raster content", async () => {
    const stream = Readable.from([Buffer.from("<svg/>")]);
    const readContent = vi.fn().mockResolvedValue(content({ stream, mimeType: "image/svg+xml" }));
    await expect(
      controllers({ readContent }).attachments.content(
        request({ workspaceId, attachmentId }),
        fakeResponse().response,
        {},
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "UNPROCESSABLE_ENTITY" } });
    expect(stream.destroyed).toBe(true);
  });

  it("propagates a not-found service result for a pending row", async () => {
    const readContent = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("not found"), { safeResponse: { code: "NOT_FOUND" } }),
      );
    await expect(
      controllers({ readContent }).attachments.content(
        request({ workspaceId, attachmentId }),
        fakeResponse().response,
        {},
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
  });

  it("enforces trusted origin and an idempotency key before parsing the upload body", async () => {
    const uploadImage = vi.fn();
    const forbidden = vi.fn(() => {
      throw new Error("origin rejected");
    });
    await expect(
      controllers({ uploadImage }, forbidden).notes.upload(request({ workspaceId, noteId })),
    ).rejects.toThrow("origin rejected");
    expect(uploadImage).not.toHaveBeenCalled();

    // Trusted origin but no Idempotency-Key: still refused before any parsing.
    await expect(
      controllers({ uploadImage }).notes.upload(
        request({ workspaceId, noteId }, { origin: trustedOrigin.origin }),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("requires a trusted origin before deleting", async () => {
    const remove = vi.fn().mockResolvedValue({ id: attachmentId, deleted: true });
    const origin = vi.fn();
    const result = await controllers({ delete: remove }, origin).attachments.delete(
      request({ workspaceId, attachmentId }, trustedOrigin),
    );
    expect(origin).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: attachmentId, deleted: true });
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, attachmentId, principal: expect.anything() }),
    );
  });

  it("delegates the note listing without accepting client-supplied scope", async () => {
    const listForNote = vi.fn().mockResolvedValue({ items: [] });
    await controllers({ listForNote }).notes.list(request({ workspaceId, noteId }));
    expect(listForNote).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, noteId, requestId: null }),
    );
  });

  it("routes one upload endpoint to the image or the file path by sniffed bytes", async () => {
    const uploadImage = vi.fn().mockResolvedValue({ attachment: { id: attachmentId } });
    const uploadFile = vi.fn().mockResolvedValue({ attachment: { id: attachmentId } });
    const service = { uploadImage, uploadFile, maximumUploadBytes: 50 * 1_024 * 1_024 };

    // A PNG named `.pdf`: the BYTES decide, so the image path runs.
    stageUpload(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32, 0x11),
      ]),
      "invoice.pdf",
      "application/pdf",
    );
    await controllers(service).notes.upload(request({ workspaceId, noteId }, trustedOrigin));
    expect(uploadImage).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();

    // A PDF named `.png`: the file path runs.
    uploadImage.mockClear();
    stageUpload(Buffer.from("%PDF-1.7\n%%EOF\n", "latin1"), "photo.png", "image/png");
    await controllers(service).notes.upload(request({ workspaceId, noteId }, trustedOrigin));
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploadImage).not.toHaveBeenCalled();

    // Allow-listed text also routes to the file path.
    uploadFile.mockClear();
    stageUpload(Buffer.from("# notes\n", "utf8"), "notes.md", "text/markdown");
    await controllers(service).notes.upload(request({ workspaceId, noteId }, trustedOrigin));
    expect(uploadFile).toHaveBeenCalledOnce();
  });

  it("refuses an unsupported payload at the transport without calling either service method", async () => {
    const uploadImage = vi.fn();
    const uploadFile = vi.fn();
    stageUpload(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "setup.exe", "application/octet-stream");
    await expect(
      controllers({ uploadImage, uploadFile, maximumUploadBytes: 1_024 }).notes.upload(
        request({ workspaceId, noteId }, trustedOrigin),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "UNPROCESSABLE_ENTITY" } });
    expect(uploadImage).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID route parameter", () => {
    const listForNote = vi.fn();
    expect(() =>
      controllers({ listForNote }).notes.list(request({ workspaceId, noteId: "../../etc" })),
    ).toThrow();
    expect(listForNote).not.toHaveBeenCalled();
  });
});

describe("contentDisposition", () => {
  it("emits an ASCII fallback plus an RFC 5987 UTF-8 form", () => {
    expect(contentDisposition("plain.png")).toBe(
      `inline; filename="plain.png"; filename*=UTF-8''plain.png`,
    );
    expect(contentDisposition("漢字.png")).toBe(
      `inline; filename="__.png"; filename*=UTF-8''%E6%BC%A2%E5%AD%97.png`,
    );
    expect(contentDisposition('quote".png')).toContain('filename="quote_.png"');
    expect(contentDisposition("back\\slash.png")).toContain('filename="back_slash.png"');
  });

  it("emits an attachment disposition on request while preserving the original name", () => {
    expect(contentDisposition("Quarterly Report.pdf", "attachment")).toBe(
      `attachment; filename="Quarterly Report.pdf"; filename*=UTF-8''Quarterly%20Report.pdf`,
    );
    expect(contentDisposition("報告書.xlsx", "attachment")).toBe(
      `attachment; filename="___.xlsx"; filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.xlsx`,
    );
    // The default is still `inline`, so the Part 40 image path is unchanged.
    expect(contentDisposition("plain.png")).toContain("inline;");
  });
});

describe("matchesEtag", () => {
  it("tolerates quotes and the weak-comparison prefix", () => {
    expect(matchesEtag(undefined, "abc")).toBe(false);
    expect(matchesEtag("abc", "abc")).toBe(true);
    expect(matchesEtag('"abc"', "abc")).toBe(true);
    expect(matchesEtag('W/"abc"', "abc")).toBe(true);
    expect(matchesEtag('"other"', "abc")).toBe(false);
  });
});
