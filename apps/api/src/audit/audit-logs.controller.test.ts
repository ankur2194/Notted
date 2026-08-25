// Part 71. Transport-level tests only: a hand-rolled fake service and fake
// `Request`/`Response`, exactly like `api-keys.controller.test.ts`. No Nest
// testing module is needed because every guard this controller relies on is
// expressed as METADATA (`RequireAuthorization`, `RateLimitTier`) and is
// observable without a running application.

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AUDIT_LOG_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { RATE_LIMIT_TIER } from "../common/rate-limit/rate-limit.decorator";

import { auditLogsToCsv } from "./audit-csv";
import { AuditLogsController } from "./audit-logs.controller";

import type { AuditLogsService } from "./audit-logs.service";
import type { AuditLogEntry, AuditLogPage } from "@notted/shared-types";
import type { Request, Response } from "express";

const userId = "90000000-0000-4000-8000-000000000001";
const workspaceId = "90000000-0000-4000-8100-000000000001";

function request(params: Record<string, string> = { workspaceId }): Request {
  const value = { params } as unknown as Request;
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

function fakeResponse() {
  const headers = new Map<string, string>();
  let body = "";
  const status = vi.fn(() => response);
  const send = vi.fn((payload: string) => {
    body = payload;
    return response;
  });
  const response = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    status,
    send,
  } as unknown as Response;
  return { response, headers, status, send, body: () => body };
}

function controller(service: Partial<AuditLogsService>): AuditLogsController {
  return new AuditLogsController(service as AuditLogsService);
}

function specOf(handler: unknown): HttpAuthorizationSpec {
  return Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler as object) as HttpAuthorizationSpec;
}

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return Object.freeze({
    id: "10000000-0000-4000-8000-000000000001",
    workspaceId,
    userId,
    userName: "Ada Lovelace",
    action: "note.update",
    entityType: "note",
    entityId: "40000000-0000-4000-8000-000000000001",
    metadata: { field: "title" },
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    requestId: "req-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("AuditLogsController", () => {
  it("publishes the canonical REST paths under the versioned prefix", () => {
    expect(AUDIT_LOG_API_PATHS.collection(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/audit-logs",
    );
    expect(AUDIT_LOG_API_PATHS.export(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/audit-logs/export",
    );
    expect(Reflect.getMetadata(PATH_METADATA, AuditLogsController)).toBe(
      "workspaces/:workspaceId/audit-logs",
    );
  });

  it("declares the export route's literal path first so no future param route can shadow it", () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuditLogsController.prototype.export)).toBe("export");
    expect(Reflect.getMetadata(METHOD_METADATA, AuditLogsController.prototype.export)).toBe(
      RequestMethod.GET,
    );
  });

  it("binds list to audit.read and export to audit.export, both over the workspace", () => {
    const listSpec = specOf(AuditLogsController.prototype.list);
    expect(listSpec.action).toBe("audit.read");
    expect(listSpec.workspaceId(request())).toBe(workspaceId);
    expect(listSpec.resource(request())).toEqual({ kind: "workspace" });

    const exportSpec = specOf(AuditLogsController.prototype.export);
    expect(exportSpec.action).toBe("audit.export");
    expect(exportSpec.workspaceId(request())).toBe(workspaceId);
    expect(exportSpec.resource(request())).toEqual({ kind: "workspace" });
  });

  it("puts the export route in the sensitive rate-limit tier and leaves list unmetered", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, AuditLogsController.prototype.export)).toBe(
      "sensitive",
    );
    expect(
      Reflect.getMetadata(RATE_LIMIT_TIER, AuditLogsController.prototype.list),
    ).toBeUndefined();
  });

  it("parses a valid list query and forwards the filters and the route workspace id", async () => {
    const page: AuditLogPage = Object.freeze({ items: [], page: 2, limit: 10, hasMore: false });
    const list = vi.fn().mockResolvedValue(page);
    const result = await controller({ list }).list(request({ workspaceId }), {
      page: "2",
      limit: "10",
      action: "note.update",
      entityType: "note",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
    });
    expect(result).toBe(page);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        page: 2,
        limit: 10,
        action: "note.update",
        entityType: "note",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
      }),
    );
  });

  it("rejects a malformed list query with a 400 VALIDATION_ERROR and never reaches the service", () => {
    const list = vi.fn();
    expect(() => controller({ list }).list(request({ workspaceId }), { page: "0" })).toThrow(
      "The request is invalid.",
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an export query carrying pagination fields it does not accept", async () => {
    const exportRows = vi.fn();
    const { response } = fakeResponse();
    await expect(
      controller({ exportRows }).export(request({ workspaceId }), { page: "2" }, response),
    ).rejects.toThrow("The request is invalid.");
    expect(exportRows).not.toHaveBeenCalled();
  });

  it("streams the exact CSV the encoder produces and sets every download header", async () => {
    const rows = [entry()];
    const exportRows = vi.fn().mockResolvedValue(rows);
    const { response, headers, status, send } = fakeResponse();

    await controller({ exportRows }).export(
      request({ workspaceId }),
      { action: "note.update" },
      response,
    );

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        action: "note.update",
      }),
    );

    const expectedCsv = auditLogsToCsv(rows);
    expect(send).toHaveBeenCalledWith(expectedCsv);
    expect(status).toHaveBeenCalledWith(200);

    expect(headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const disposition = headers.get("content-disposition") ?? "";
    expect(disposition.startsWith("attachment;")).toBe(true);
    // `contentDisposition` percent-encodes the filename twice (ASCII fallback
    // + `filename*=UTF-8''...`); a plain workspace id and yyyymmdd date carry
    // no characters either form escapes, so the raw filename is a safe substring.
    expect(disposition).toMatch(new RegExp(`audit-logs-${workspaceId}-\\d{8}\\.csv`, "u"));

    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("vary")).toBe("Cookie");
    expect(headers.get("content-length")).toBe(String(Buffer.byteLength(expectedCsv, "utf8")));
  });
});
