import { Readable, Writable } from "node:stream";

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_TIER } from "../common/rate-limit/rate-limit.decorator";

import { PublicAttachmentController } from "./public-attachment.controller";

import type { AttachmentContent, AttachmentsService } from "./attachments.service";
import type { Response } from "express";

const attachmentId = "20000000-0000-4000-8900-000000000001";
const token = "a".repeat(32);

function response() {
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const status = vi.fn(() => output);
  const output = Object.assign(sink, {
    setHeader: (key: string, value: string) => headers.set(key.toLowerCase(), value),
    status,
  }) as unknown as Response;
  return { output, headers, chunks, status, sink };
}

function content(mediaType: "image" | "file", mimeType: string): AttachmentContent {
  return {
    stream: Readable.from([Buffer.from("bytes")]),
    mediaType,
    mimeType,
    etag: "etag-secret",
    filename: mediaType === "file" ? "Quarterly Report.pdf" : "photo.jpg",
    contentLength: 5,
  };
}

describe("PublicAttachmentController", () => {
  it("exposes the unauthenticated public route and delegates only token and attachment ID", async () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicAttachmentController)).toBe(
      "public/notes/:token/attachments",
    );
    expect(Reflect.getMetadata(PATH_METADATA, PublicAttachmentController.prototype.content)).toBe(
      ":attachmentId/content",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, PublicAttachmentController.prototype.content)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, PublicAttachmentController.prototype.content)).toBe(
      "public-ip",
    );
    const readPublicContent = vi.fn().mockResolvedValue(content("image", "image/png"));
    const target = response();
    await new PublicAttachmentController({
      readPublicContent,
    } as unknown as AttachmentsService).content(token, attachmentId, target.output);
    expect(readPublicContent).toHaveBeenCalledExactlyOnceWith({ token, attachmentId });
    expect(target.status).toHaveBeenCalledWith(200);
    expect(target.headers.get("content-disposition")).toContain("inline;");
    expect(target.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(target.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(target.headers.get("x-content-type-options")).toBe("nosniff");
    expect(target.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(target.headers.has("etag")).toBe(false);
  });

  it("downloads files under the sanitized name without validators or shared-cache eligibility", async () => {
    const readPublicContent = vi.fn().mockResolvedValue(content("file", "application/pdf"));
    const target = response();
    await new PublicAttachmentController({
      readPublicContent,
    } as unknown as AttachmentsService).content(token, attachmentId, target.output);
    expect(target.headers.get("content-disposition")).toBe(
      `attachment; filename="Quarterly Report.pdf"; filename*=UTF-8''Quarterly%20Report.pdf`,
    );
    expect(target.headers.get("content-length")).toBe("5");
    expect(target.headers.get("content-type")).toBe("application/pdf");
    expect(target.headers.has("etag")).toBe(false);
  });

  it("returns the same 404 on malformed ID or denied lookup, with no-store", async () => {
    const readPublicContent = vi.fn().mockResolvedValue(null);
    const controller = new PublicAttachmentController({
      readPublicContent,
    } as unknown as AttachmentsService);
    for (const id of ["not-a-uuid", attachmentId]) {
      const target = response();
      await expect(controller.content(token, id, target.output)).rejects.toMatchObject({
        safeResponse: { code: "NOT_FOUND", message: "The requested resource was not found." },
      });
      expect(target.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    }
    expect(readPublicContent).toHaveBeenCalledTimes(1);
  });
});
