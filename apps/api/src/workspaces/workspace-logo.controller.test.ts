import { Readable, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { WorkspaceLogoController } from "./workspace-logo.controller";
import { WORKSPACE_LOGO_CACHE_CONTROL } from "./workspace-logo.service";

import type { WorkspaceLogoContent, WorkspaceLogoService } from "./workspace-logo.service";
import type { ParsedSingleFileUpload } from "../attachments/multipart-upload.parser";
import type { AuthService } from "../auth/auth.service";
import type { Request, Response } from "express";

/**
 * Busboy is replaced so the transport's ORDER can be asserted — the trusted
 * origin check must run before a body byte is read. Every other guard on the
 * route stays real.
 */
const parserStub = vi.hoisted(() => ({ next: null as ParsedSingleFileUpload | null }));

vi.mock("../attachments/multipart-upload.parser", () => ({
  parseSingleFileUpload: vi.fn(() => {
    if (parserStub.next === null) throw new Error("no multipart payload was staged");
    return Promise.resolve(parserStub.next);
  }),
  MULTIPART_OVERHEAD_BYTES: 16 * 1_024,
  MULTIPART_TIMEOUT_MS: 30_000,
}));

function stageUpload(buffer: Buffer): void {
  parserStub.next = Object.freeze({
    buffer,
    declaredMimeType: "image/png",
    declaredFilename: "wordmark.png",
    fields: Object.freeze({}),
  });
}

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const token = "a".repeat(32);
const logoUrl = `/api/v1/workspaces/${workspaceId}/logo/${token}`;

function request(
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
  withPrincipal = true,
): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const value = {
    params,
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
  if (withPrincipal) {
    setAuthPrincipal(value, {
      userId,
      sessionId: "session",
      method: "opaque-session",
      assurance: "single-factor",
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      isFresh: true,
    });
  }
  return value;
}

/** A real `Writable` so `stream.pipe(response)` behaves as it does in Express. */
function fakeResponse() {
  const headers = new Map<string, string>();
  const sink = new Writable({
    write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      callback();
    },
  });
  const status = vi.fn(() => response);
  const response = Object.assign(sink, {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    status,
  }) as unknown as Response;
  return { response, headers, sink, status };
}

function logoContent(overrides: Partial<WorkspaceLogoContent> = {}): WorkspaceLogoContent {
  return Object.freeze({
    stream: Readable.from([Buffer.from("webp")]),
    etag: '"logo-etag"',
    contentLength: 4,
    mimeType: "image/webp",
    ...overrides,
  });
}

function controller(service: Partial<WorkspaceLogoService>, origin = vi.fn()) {
  const auth = { assertTrustedMutationOrigin: origin } as unknown as AuthService;
  return {
    controller: new WorkspaceLogoController(service as WorkspaceLogoService, auth),
    origin,
  };
}

function specOf(handler: unknown): HttpAuthorizationSpec | undefined {
  return Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler as object) as
    HttpAuthorizationSpec | undefined;
}

describe("WorkspaceLogoController mutations", () => {
  it("requires a trusted mutation origin before parsing an upload body", async () => {
    const upload = vi.fn();
    const forbidden = vi.fn(() => {
      throw new Error("origin rejected");
    });
    stageUpload(Buffer.from("would-have-been-parsed"));

    await expect(
      controller({ upload }, forbidden).controller.upload(request({ workspaceId })),
    ).rejects.toThrow("origin rejected");
    expect(upload).not.toHaveBeenCalled();

    const allowed = controller({ upload: vi.fn().mockResolvedValue({ logoUrl }) });
    const result = await allowed.controller.upload(
      request({ workspaceId }, { origin: "https://app.notted.test" }),
    );
    expect(allowed.origin).toHaveBeenCalledOnce();
    expect(result).toEqual({ logoUrl });
  });

  it("requires a trusted mutation origin before removing", async () => {
    const remove = vi.fn().mockResolvedValue({ logoUrl: null });
    const allowed = controller({ remove });
    const result = await allowed.controller.remove(
      request({ workspaceId }, { origin: "https://app.notted.test" }),
    );
    expect(allowed.origin).toHaveBeenCalledOnce();
    expect(result).toEqual({ logoUrl: null });
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, principal: expect.anything() }),
    );

    const forbidden = vi.fn(() => {
      throw new Error("origin rejected");
    });
    const denied = vi.fn();
    // `remove` is not `async`, so the origin refusal propagates synchronously
    // rather than as a rejected promise. Nest handles either; the assertion has
    // to match which one the handler actually does.
    expect(() =>
      controller({ remove: denied }, forbidden).controller.remove(request({ workspaceId })),
    ).toThrow("origin rejected");
    expect(denied).not.toHaveBeenCalled();
  });

  it("binds both mutations to settings.update", () => {
    for (const handler of [
      WorkspaceLogoController.prototype.upload,
      WorkspaceLogoController.prototype.remove,
    ]) {
      expect(specOf(handler)?.action).toBe("settings.update");
      expect(specOf(handler)?.resource(request({ workspaceId }))).toEqual({ kind: "settings" });
    }
  });
});

describe("WorkspaceLogoController public read", () => {
  it("serves the rendition with publicly cacheable, immutable, non-sniffable headers", async () => {
    const read = vi.fn().mockResolvedValue(logoContent());
    const { response, headers, status } = fakeResponse();
    const { origin, controller: subject } = controller({ read });

    await subject.content(request({ workspaceId, token }), response);

    expect(read).toHaveBeenCalledWith(workspaceId, token);
    expect(headers.get("content-type")).toBe("image/webp");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    // PUBLIC, unlike the attachment route's `private`: the token changes on
    // every replacement, so a shared cache can never hold a superseded logo.
    expect(headers.get("cache-control")).toBe(WORKSPACE_LOGO_CACHE_CONTROL);
    expect(headers.get("cache-control")).toContain("public");
    expect(headers.get("etag")).toBe('"logo-etag"');
    expect(headers.get("content-length")).toBe("4");
    expect(status).toHaveBeenCalledWith(200);
    // A mail client's <img> has no Origin and no session, so this route must
    // not run the CSRF check that guards the mutations.
    expect(origin).not.toHaveBeenCalled();
  });

  it("needs no principal and carries no authorization spec", async () => {
    const read = vi.fn().mockResolvedValue(logoContent());
    const { response } = fakeResponse();
    // The route is deliberately unguarded: the 128-bit path token IS the
    // authorization, so an unauthenticated request must still be served.
    await controller({ read }).controller.content(
      request({ workspaceId, token }, {}, false),
      response,
    );
    expect(read).toHaveBeenCalledOnce();
    expect(specOf(WorkspaceLogoController.prototype.content)).toBeUndefined();
  });

  it("answers a matching If-None-Match with 304, no Content-Length, and a destroyed stream", async () => {
    const stream = Readable.from([Buffer.from("webp")]);
    const read = vi.fn().mockResolvedValue(logoContent({ stream }));
    const { response, headers, status, sink } = fakeResponse();

    await controller({ read }).controller.content(
      request({ workspaceId, token }, { "if-none-match": '"logo-etag"' }),
      response,
    );

    expect(status).toHaveBeenCalledWith(304);
    expect(sink.writableEnded).toBe(true);
    // RFC 9110 §15.4.5: a 304 carries no body, so it must not advertise one.
    expect(headers.get("content-length")).toBeUndefined();
    // The validators a cache still needs ARE present.
    expect(headers.get("etag")).toBe('"logo-etag"');
    expect(headers.get("cache-control")).toBe(WORKSPACE_LOGO_CACHE_CONTROL);
    // The object stream is released rather than left dangling on the store.
    expect(stream.destroyed).toBe(true);
  });

  /*
   * A 404, not a 500.
   *
   * The selector used `uuidSchema.parse`, and this route is the one deliberately
   * public, unauthenticated handler here -- so it has no
   * `AuthorizationHttpGuard` to wrap the selector in try/catch, and the global
   * filter has no `ZodError` branch. Attacker-controlled input therefore
   * produced 500 INTERNAL_SERVER_ERROR plus an "Unhandled HTTP exception" log
   * line, on a service whose whole contract is that every miss -- unknown
   * workspace, wrong token, absent object -- answers one identical 404.
   *
   * The previous version of this test asserted only `rejects.toThrow()`, which
   * the 500 satisfied.
   */
  it("answers a non-UUID workspace with the same 404 as every other miss", async () => {
    const read = vi.fn();
    await expect(
      controller({ read }).controller.content(
        request({ workspaceId: "../../etc", token }),
        fakeResponse().response,
      ),
    ).rejects.toMatchObject({
      status: 404,
      safeResponse: { code: "NOT_FOUND" },
    });
    expect(read).not.toHaveBeenCalled();
  });
});
