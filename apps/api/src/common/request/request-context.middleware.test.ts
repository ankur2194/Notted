import { describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "../logging/structured-logger.service";

import { getRequestContext } from "./request-context";
import {
  RequestContextMiddleware,
  redactSecretPathSegment,
  selectRequestId,
} from "./request-context.middleware";

import type { NextFunction, Request, Response } from "express";

describe("selectRequestId", () => {
  it("accepts only bounded version-4 UUID request IDs", () => {
    const incoming = "9BB58C7E-8F49-4A7D-B60C-0E32A30A2980";

    expect(selectRequestId(incoming, () => "generated")).toBe(incoming.toLowerCase());
    expect(selectRequestId("not-safe", () => "generated")).toBe("generated");
    expect(selectRequestId("a".repeat(100), () => "generated")).toBe("generated");
  });
});

function fakeResponse(): Response & { emitFinish: () => void } {
  const handlers = new Map<string, () => void>();
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    emitFinish: () => handlers.get("finish")?.(),
  } as unknown as Response & { emitFinish: () => void };
}

function fakeRequest(
  overrides: Partial<Record<"ip" | "userAgent" | "originalUrl" | "path", string>> = {},
): Request {
  return {
    method: "GET",
    path: overrides.path ?? "/api/v1/workspaces",
    originalUrl: overrides.originalUrl ?? overrides.path ?? "/api/v1/workspaces",
    headers: {} as Record<string, string>,
    ip: overrides.ip,
    header: (name: string) => (name === "user-agent" ? overrides.userAgent : undefined),
  } as unknown as Request;
}

function middleware(): RequestContextMiddleware {
  return new RequestContextMiddleware({ info: vi.fn() } as unknown as StructuredLogger);
}

describe("RequestContextMiddleware request context", () => {
  it("binds the request id, address and agent for the downstream chain", () => {
    const seen: ReturnType<typeof getRequestContext>[] = [];
    const next: NextFunction = () => {
      seen.push(getRequestContext());
    };

    middleware().use(
      fakeRequest({ ip: "203.0.113.7", userAgent: "Mozilla/5.0" }),
      fakeResponse(),
      next,
    );

    expect(seen[0]).toMatchObject({ ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0" });
    expect(seen[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("truncates both fields to their column widths and normalizes an empty agent", () => {
    const seen: ReturnType<typeof getRequestContext>[] = [];
    middleware().use(fakeRequest({ ip: "a".repeat(80), userAgent: "" }), fakeResponse(), () => {
      seen.push(getRequestContext());
    });

    expect(seen[0]).not.toBeNull();
    expect(seen[0]?.ipAddress).toHaveLength(45);
    expect(seen[0]?.userAgent).toBeNull();
  });

  it("bounds an oversized user agent rather than passing it through", () => {
    const seen: ReturnType<typeof getRequestContext>[] = [];
    middleware().use(fakeRequest({ userAgent: "u".repeat(2_000) }), fakeResponse(), () => {
      seen.push(getRequestContext());
    });

    expect(seen[0]?.userAgent).toHaveLength(512);
    expect(seen[0]?.ipAddress).toBeNull();
  });

  it("leaves no context bound once the request chain has returned", () => {
    middleware().use(fakeRequest({ ip: "198.51.100.4" }), fakeResponse(), () => undefined);

    expect(getRequestContext()).toBeNull();
  });
});

describe("redactSecretPathSegment", () => {
  it("redacts the raw token on a public-note view", () => {
    expect(redactSecretPathSegment("/api/v1/public/notes/abcdef0123456789")).toBe(
      "/api/v1/public/notes/[redacted]",
    );
  });

  it("redacts the raw token on a workspace logo fetch", () => {
    expect(
      redactSecretPathSegment("/api/v1/workspaces/11111111-1111-1111-1111-111111111111/logo/xyz"),
    ).toBe("/api/v1/workspaces/11111111-1111-1111-1111-111111111111/logo/[redacted]");
  });

  it("leaves an ordinary path untouched", () => {
    const path =
      "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/notes/22222222-2222-2222-2222-222222222222";
    expect(redactSecretPathSegment(path)).toBe(path);
  });

  it("redacts a trailing-slash variant, which Express still routes to the same handler", () => {
    expect(redactSecretPathSegment("/api/v1/public/notes/abcdef0123456789/")).toBe(
      "/api/v1/public/notes/[redacted]",
    );
  });

  it("redacts a case-variant path, which Express still routes to the same handler", () => {
    expect(redactSecretPathSegment("/api/v1/PUBLIC/NOTES/abcdef0123456789")).toBe(
      "/api/v1/PUBLIC/NOTES/[redacted]",
    );
  });
});

describe("RequestContextMiddleware secret path redaction in logs", () => {
  it("redacts a public-note token before logging path, but logs an ordinary path unredacted", () => {
    const info = vi.fn();
    const logger = { info } as unknown as StructuredLogger;

    const secretResponse = fakeResponse();
    new RequestContextMiddleware(logger).use(
      fakeRequest({ originalUrl: "/api/v1/public/notes/super-secret-raw-token?foo=bar" }),
      secretResponse,
      () => undefined,
    );
    secretResponse.emitFinish();

    const ordinaryResponse = fakeResponse();
    new RequestContextMiddleware(logger).use(
      fakeRequest({
        originalUrl:
          "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/notes/22222222-2222-2222-2222-222222222222",
      }),
      ordinaryResponse,
      () => undefined,
    );
    ordinaryResponse.emitFinish();

    expect(info).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: "/api/v1/public/notes/[redacted]" }),
      "HTTP request completed",
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/notes/22222222-2222-2222-2222-222222222222",
      }),
      "HTTP request completed",
    );
  });
});
