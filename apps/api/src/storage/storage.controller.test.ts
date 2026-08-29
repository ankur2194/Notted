// Part 45 — the workspace storage transport.
//
// The controller is required to be thin: parse with the shared Zod schemas,
// delegate, and let the central policy decide who may call. These tests assert
// exactly that, plus the two rules that make the administrative cleanup route
// safe by default — an absent body means `dryRun: true`, and a malformed body is
// refused rather than being read as "delete everything".
//
// Negative authorization is proven against the REAL policy service rather than a
// permissive double: the route declares `settings.update`, and the policy grants
// that action to owner/admin only.

import { RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";
import { RATE_LIMIT_TIER } from "../common/rate-limit/rate-limit.decorator";
import { setRequestId } from "../common/request/request-context";

import { StorageController } from "./storage.controller";

import type { StorageQuotaService } from "./storage-quota.service";
import type { AuthService } from "../auth/auth.service";
import type {
  AuthorizationEvaluation,
  AuthorizationResourceFacts,
  UserAuthorizationActor,
  WorkspaceRole,
} from "../authorization/authorization.contracts";
import type { StorageMaintenanceService } from "../maintenance/storage-maintenance.service";
import type { Request } from "express";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const userId = "40000000-0000-4000-8000-000000000001";
const workspaceId = "40000000-0000-4000-8100-000000000001";

function request(params: Record<string, string> = { workspaceId }, requestId?: string): Request {
  const value = { params, headers: {} } as unknown as Request;
  setAuthPrincipal(value, {
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    isFresh: true,
  });
  if (requestId !== undefined) setRequestId(value, requestId);
  return value;
}

function controller(
  quota: Partial<StorageQuotaService> = {},
  maintenance: Partial<StorageMaintenanceService> = {},
  origin = vi.fn(),
) {
  const auth = { assertTrustedMutationOrigin: origin } as unknown as AuthService;
  return {
    controller: new StorageController(
      quota as StorageQuotaService,
      maintenance as StorageMaintenanceService,
      auth,
    ),
    origin,
  };
}

function specOf(handler: unknown): HttpAuthorizationSpec {
  return Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler as object) as HttpAuthorizationSpec;
}

/**
 * `runMaintenance` is deliberately NOT `async` — its origin, body, and route
 * guards therefore throw synchronously. This wrapper turns those throws into
 * rejections so one assertion style covers both.
 */
async function callMaintenance(
  built: ReturnType<typeof controller>,
  value: Request,
  body: unknown,
): Promise<unknown> {
  return built.controller.runMaintenance(value, body);
}

const report = Object.freeze({
  startedAt: new Date(NOW).toISOString(),
  finishedAt: new Date(NOW).toISOString(),
  dryRun: true,
  scope: "workspace" as const,
  sweeps: Object.freeze([]),
});

describe("StorageController", () => {
  it("mounts the storage routes under the workspace prefix", () => {
    expect(Reflect.getMetadata(PATH_METADATA, StorageController)).toBe(
      "workspaces/:workspaceId/storage",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, StorageController.prototype.read)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, StorageController.prototype.runMaintenance)).toBe(
      RequestMethod.POST,
    );
  });

  it("answers the maintenance POST with 200, because it creates nothing", () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, StorageController.prototype.runMaintenance),
    ).toBe(200);
  });

  it("puts the cleanup route on the sensitive tier and leaves the read route alone", () => {
    // The most expensive request the API serves -- four sweeps, two bucket
    // listings, up to `maintenanceBatchLimit` object stats -- held only the
    // caller's general allowance. The sensitive tier has its own bucket, so the
    // cooldown cannot lock an admin out of the rest of the product.
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, StorageController.prototype.runMaintenance)).toBe(
      "sensitive",
    );
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, StorageController.prototype.read)).toBeUndefined();
  });

  it("binds the read route to settings.read and the cleanup route to settings.update", () => {
    const readSpec = specOf(StorageController.prototype.read);
    expect(readSpec.action).toBe("settings.read");
    expect(readSpec.resource(request())).toEqual({ kind: "settings" });
    expect(readSpec.workspaceId(request())).toBe(workspaceId);

    const maintenanceSpec = specOf(StorageController.prototype.runMaintenance);
    expect(maintenanceSpec.action).toBe("settings.update");
    expect(maintenanceSpec.resource(request())).toEqual({ kind: "settings" });
    expect(maintenanceSpec.workspaceId(request())).toBe(workspaceId);
  });

  it("delegates the read with the principal, the route workspace id, and the request id", async () => {
    const readUsage = vi.fn().mockResolvedValue({ workspaceId, usedBytes: 0 });
    await controller({ readUsage }).controller.read(request({ workspaceId }, "request-77"));
    expect(readUsage).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      requestId: "request-77",
    });
  });

  it("passes a null request id when the correlation middleware did not set one", async () => {
    const readUsage = vi.fn().mockResolvedValue({ workspaceId });
    await controller({ readUsage }).controller.read(request());
    expect(readUsage).toHaveBeenCalledWith(expect.objectContaining({ requestId: null }));
  });

  it("defaults dryRun to TRUE for an absent body", async () => {
    const runForWorkspace = vi.fn().mockResolvedValue(report);
    for (const body of [undefined, null, {}]) {
      runForWorkspace.mockClear();
      await callMaintenance(controller({}, { runForWorkspace }), request(), body);
      expect(runForWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, dryRun: true }),
      );
    }
  });

  it("honours an explicit dryRun: false", async () => {
    const runForWorkspace = vi.fn().mockResolvedValue({ ...report, dryRun: false });
    await callMaintenance(controller({}, { runForWorkspace }), request(), { dryRun: false });
    expect(runForWorkspace).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });

  it("rejects a malformed body with a 400 VALIDATION_ERROR and runs nothing", async () => {
    const runForWorkspace = vi.fn();
    const malformed: readonly unknown[] = [
      { dryRun: "false" },
      { dryRun: 0 },
      { dryRun: true, purge: true },
      { unexpected: 1 },
      [],
      "dryRun=false",
      42,
    ];
    for (const body of malformed) {
      await expect(
        callMaintenance(controller({}, { runForWorkspace }), request(), body),
      ).rejects.toMatchObject({ safeResponse: { code: "VALIDATION_ERROR" } });
    }
    expect(runForWorkspace).not.toHaveBeenCalled();
  });

  it("asserts a trusted mutation origin before anything else happens", async () => {
    const runForWorkspace = vi.fn().mockResolvedValue(report);
    const accepted = controller({}, { runForWorkspace });
    await callMaintenance(accepted, request(), {});
    expect(accepted.origin).toHaveBeenCalledOnce();

    const rejected = controller(
      {},
      { runForWorkspace },
      vi.fn(() => {
        throw new Error("origin rejected");
      }),
    );
    // Refused before the body is even parsed, so a malformed body cannot be
    // used to probe the origin check.
    await expect(callMaintenance(rejected, request(), { dryRun: "nope" })).rejects.toThrow(
      "origin rejected",
    );
    expect(runForWorkspace).toHaveBeenCalledOnce();
  });

  it("returns the maintenance report unchanged", async () => {
    const runForWorkspace = vi.fn().mockResolvedValue(report);
    await expect(
      callMaintenance(controller({}, { runForWorkspace }), request(), undefined),
    ).resolves.toBe(report);
  });

  it("rejects a non-UUID route parameter on both routes", async () => {
    const readUsage = vi.fn();
    const runForWorkspace = vi.fn();
    const built = controller({ readUsage }, { runForWorkspace });
    expect(() => built.controller.read(request({ workspaceId: "../../etc/passwd" }))).toThrow();
    await expect(
      callMaintenance(built, request({ workspaceId: "not-a-uuid" }), {}),
    ).rejects.toThrow();
    expect(readUsage).not.toHaveBeenCalled();
    expect(runForWorkspace).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Negative authorization — the real policy, not a permissive double            */
/* -------------------------------------------------------------------------- */

function settingsFacts(): AuthorizationResourceFacts {
  return Object.freeze({
    kind: "settings",
    id: "settings-1",
    workspaceId,
    project: null,
    loadedAt: new Date(NOW).toISOString(),
    relationsValid: true,
    creatorId: userId,
  });
}

function actor(): UserAuthorizationActor {
  return Object.freeze({
    kind: "user",
    userId,
    sessionId: "session-1",
    assurance: "single-factor",
    authenticatedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    isFresh: true,
    source: "session",
  });
}

function evaluation(role: WorkspaceRole, action: string): AuthorizationEvaluation {
  return {
    actor: actor(),
    action,
    resource: settingsFacts(),
    tenant: {
      workspaceId,
      membershipRole: role,
      membershipLoadedAt: new Date(NOW).toISOString(),
    },
  };
}

describe("storage route authorization", () => {
  const policy = new AuthorizationPolicyService();

  it("lets every role READ usage", () => {
    const action = specOf(StorageController.prototype.read).action;
    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      expect(policy.decide(evaluation(role, action), NOW).allowed).toBe(true);
    }
  });

  it("denies an editor and a viewer the cleanup route while allowing owner and admin", () => {
    const action = specOf(StorageController.prototype.runMaintenance).action;
    expect(policy.decide(evaluation("owner", action), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("admin", action), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("editor", action), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("viewer", action), NOW).allowed).toBe(false);
  });
});
