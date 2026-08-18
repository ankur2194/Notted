// Part 62. Transport-level tests only: a hand-rolled fake service and fake
// `Request`/`Response`, exactly like `attachments.controller.test.ts`. No Nest
// testing module is needed because every guard this controller relies on is
// expressed as METADATA (`RequireAuthorization`) or as a direct call
// (`assertTrustedMutationOrigin`, `requireIdempotencyKey`) — both are
// observable without a running application.

import { Readable, Writable } from "node:stream";

import { RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { EXPORT_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { ExportController } from "./export.controller";

import type { ExportDownloadContent, ExportService } from "./export.service";
import type { AuthService } from "../auth/auth.service";
import type { ExportJob } from "@notted/shared-types";
import type { Request, Response } from "express";

const userId = "30000000-0000-4000-8000-000000000001";
const workspaceId = "30000000-0000-4000-8100-000000000001";
const exportId = "30000000-0000-4000-8900-000000000001";
const noteId = "30000000-0000-4000-8500-000000000001";

function request(
  params: Record<string, string> = { workspaceId },
  headers: Record<string, string> = {},
  body: unknown = undefined,
): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const value = {
    params,
    headers: lower,
    body,
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

/** A real `Writable` so `stream.pipe(response)` behaves as it does in Express. */
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

function controller(service: Partial<ExportService>, origin = vi.fn()) {
  const auth = { assertTrustedMutationOrigin: origin } as unknown as AuthService;
  return { controller: new ExportController(service as ExportService, auth), origin };
}

function specOf(handler: unknown): HttpAuthorizationSpec {
  return Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler as object) as HttpAuthorizationSpec;
}

const queuedJob = Object.freeze({ id: exportId, status: "queued" }) as unknown as ExportJob;

const validBody = Object.freeze({
  format: "txt",
  sourceType: "note",
  sourceId: noteId,
  options: { includeComments: true },
});

const trustedHeaders = { origin: "https://app.notted.test", "idempotency-key": "export-000000001" };

function downloadContent(overrides: Partial<ExportDownloadContent> = {}): ExportDownloadContent {
  return Object.freeze({
    stream: Readable.from([Buffer.from("exported")]),
    filename: "Quarterly Report.txt",
    mimeType: "text/plain; charset=utf-8",
    contentLength: 8,
    ...overrides,
  });
}

describe("ExportController", () => {
  it("publishes the canonical REST paths shared with the browser client", () => {
    expect(Reflect.getMetadata(PATH_METADATA, ExportController)).toBe(
      "workspaces/:workspaceId/exports",
    );
    expect(EXPORT_API_PATHS.collection(workspaceId)).toBe(
      `/api/v1/workspaces/${workspaceId}/exports`,
    );
    expect(EXPORT_API_PATHS.download(workspaceId, exportId)).toBe(
      `/api/v1/workspaces/${workspaceId}/exports/${exportId}/download`,
    );
    // A create returns a QUEUED job, not the artefact.
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ExportController.prototype.create)).toBe(202);
    expect(Reflect.getMetadata(METHOD_METADATA, ExportController.prototype.create)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ExportController.prototype.cancel)).toBe(200);
    expect(Reflect.getMetadata(PATH_METADATA, ExportController.prototype.download)).toBe(
      ":exportId/download",
    );
  });

  it("binds each route to the right action and resource selector", () => {
    // A note source authorizes against the NOTE: that is what `export.create`
    // means for a note, and `RESOURCE_KINDS_BY_ACTION` allows it.
    const createSpec = specOf(ExportController.prototype.create);
    expect(createSpec.action).toBe("export.create");
    expect(createSpec.workspaceId(request())).toBe(workspaceId);
    expect(createSpec.resource(request({ workspaceId }, {}, validBody))).toEqual({
      kind: "note",
      id: noteId,
    });

    // A list addresses no single export.
    const listSpec = specOf(ExportController.prototype.list);
    expect(listSpec.action).toBe("workspace.read");
    expect(listSpec.resource(request())).toEqual({ kind: "workspace" });

    for (const [handler, action] of [
      [ExportController.prototype.read, "export.read"],
      [ExportController.prototype.cancel, "export.cancel"],
      [ExportController.prototype.download, "export.download"],
    ] as const) {
      const spec = specOf(handler);
      expect(spec.action).toBe(action);
      expect(spec.resource(request({ workspaceId, exportId }))).toEqual({
        kind: "export",
        id: exportId,
      });
      expect(spec.workspaceId(request({ workspaceId, exportId }))).toBe(workspaceId);
    }
  });

  it("denies at the guard rather than the handler when the create body is unparseable", () => {
    const resource = specOf(ExportController.prototype.create).resource;
    // A 400-vs-403 difference here would leak whether the caller has standing
    // in this workspace at all, so an invalid body selects no resource.
    expect(resource(request({ workspaceId }, {}, { sourceType: "note" }))).toBeNull();
    expect(resource(request({ workspaceId }, {}, undefined))).toBeNull();
    // An unsupported source falls back to the workspace and is refused later by
    // the service, without any privileged read having happened.
    expect(
      resource(request({ workspaceId }, {}, { format: "txt", sourceType: "workspace" })),
    ).toEqual({ kind: "workspace" });
  });

  it("requires an Idempotency-Key on create before touching the service", () => {
    const create = vi.fn();
    const { controller: subject, origin } = controller({ create });
    const withoutKey = request({ workspaceId }, { origin: "https://app.notted.test" }, validBody);
    expect(() => subject.create(withoutKey, validBody)).toThrow(
      "A valid Idempotency-Key header is required.",
    );
    expect(create).not.toHaveBeenCalled();
    // The origin check still ran first.
    expect(origin).toHaveBeenCalledOnce();
  });

  it("passes the key and the parsed body through to the service unchanged", async () => {
    const create = vi.fn().mockResolvedValue(queuedJob);
    const { controller: subject, origin } = controller({ create });

    await expect(
      subject.create(request({ workspaceId }, trustedHeaders, validBody), validBody),
    ).resolves.toBe(queuedJob);
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      format: "txt",
      sourceType: "note",
      sourceId: noteId,
      // The schema defaults fill the rest of the jsonb contract.
      options: {
        includeAttachments: false,
        includeComments: true,
        includeVersionHistory: false,
        headerText: null,
        footerText: null,
        margins: null,
      },
      idempotencyKey: "export-000000001",
      correlationId: null,
    });
  });

  it.each([
    ["an unknown key", { ...validBody, rushPlease: true }],
    ["a malformed source id", { format: "txt", sourceType: "note", sourceId: "not-a-uuid" }],
    [
      "a workspace source carrying an id",
      { format: "txt", sourceType: "workspace", sourceId: noteId },
    ],
    ["a missing note source id", { format: "txt", sourceType: "note" }],
  ])("rejects %s as a validation error without reaching the service", (_label, body) => {
    const create = vi.fn();
    const { controller: subject } = controller({ create });
    expect(() => subject.create(request({ workspaceId }, trustedHeaders, body), body)).toThrow(
      "The request is invalid.",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("scopes a list to the calling user and the bounded parsed pagination", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, hasMore: false });
    const { controller: subject, origin } = controller({ list });

    await subject.list(request(), { page: "2", limit: "10", status: "ready" });
    expect(list).toHaveBeenCalledWith({
      workspaceId,
      requestedById: userId,
      page: 2,
      limit: 10,
      status: "ready",
    });
    // Read routes never assert a mutation origin.
    expect(origin).not.toHaveBeenCalled();
  });

  it("rejects an unparseable list query", () => {
    const list = vi.fn();
    const { controller: subject } = controller({ list });
    expect(() => subject.list(request(), { status: "sideways" })).toThrow(
      "The request is invalid.",
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("reads a single job without asserting a mutation origin", async () => {
    const read = vi.fn().mockResolvedValue(queuedJob);
    const { controller: subject, origin } = controller({ read });

    await expect(subject.read(request({ workspaceId, exportId }))).resolves.toBe(queuedJob);
    expect(read).toHaveBeenCalledWith({ workspaceId, exportId });
    expect(origin).not.toHaveBeenCalled();
  });

  it("asserts a trusted mutation origin before cancelling", async () => {
    const cancel = vi.fn().mockResolvedValue(queuedJob);
    const { controller: subject, origin } = controller({ cancel });

    await subject.cancel(request({ workspaceId, exportId }, trustedHeaders));
    expect(origin).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({ workspaceId, exportId });
  });

  it("refuses a cancel from an untrusted origin before touching the service", () => {
    const cancel = vi.fn();
    const { controller: subject } = controller(
      { cancel },
      vi.fn(() => {
        throw new Error("The request origin is not allowed.");
      }),
    );
    expect(() => subject.cancel(request({ workspaceId, exportId }))).toThrow(
      "The request origin is not allowed.",
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it("streams the artefact as a non-cacheable, non-renderable attachment", async () => {
    const content = downloadContent();
    const openDownload = vi.fn().mockResolvedValue(content);
    const { controller: subject, origin } = controller({ openDownload });
    const { response, headers, chunks, sink, status } = fakeResponse();

    await subject.download(request({ workspaceId, exportId }), response);
    await new Promise((resolve) => sink.on("finish", resolve));

    expect(openDownload).toHaveBeenCalledWith({ workspaceId, exportId });
    expect(origin).not.toHaveBeenCalled();
    // An export is a generated document: it must never render in the API origin.
    expect(headers.get("content-disposition")).toBe(
      "attachment; filename=\"Quarterly Report.txt\"; filename*=UTF-8''Quarterly%20Report.txt",
    );
    // Principal-dependent AND expiring — unlike an immutable attachment
    // rendition, a cached copy could outlive the grant.
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(headers.get("content-length")).toBe("8");
    expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(headers.get("vary")).toBe("Cookie");
    expect(headers.get("accept-ranges")).toBe("none");
    // No validator is emitted: a single-shot expiring download has nothing to
    // revalidate against.
    expect(headers.get("etag")).toBeUndefined();
    expect(status).toHaveBeenCalledWith(200);
    expect(Buffer.concat(chunks).toString()).toBe("exported");
  });
});
