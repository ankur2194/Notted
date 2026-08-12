import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { PlatformOperatorService } from "./platform-operator.service";

import type { AuthService } from "./auth.service";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

const principal: AuthenticatedPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  method: "opaque-session",
  assurance: "single-factor",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  authenticatedAt: new Date().toISOString(),
  isFresh: true,
};

function request(): Request {
  return {} as Request;
}

function harness(input: {
  readonly available?: boolean;
  readonly authenticated?: AuthenticatedPrincipal | null;
  readonly row?: { readonly isPlatformOperator: boolean };
  readonly selectFailure?: boolean;
  readonly insertFailure?: boolean;
}) {
  const authenticate = vi.fn().mockResolvedValue(input.authenticated ?? null);
  const auth = {
    isAvailable: () => input.available ?? true,
    authenticate,
  } as unknown as AuthService;
  const limit = input.selectFailure
    ? vi.fn().mockRejectedValue(new Error("database detail"))
    : vi.fn().mockResolvedValue(input.row === undefined ? [] : [input.row]);
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  const values = input.insertFailure
    ? vi.fn().mockRejectedValue(new Error("database detail"))
    : vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  const database = { db: { select, insert } } as unknown as DatabaseService;
  return { service: new PlatformOperatorService(auth, database), authenticate, insert, values };
}

async function expectStatus(work: Promise<unknown>, status: number): Promise<void> {
  await expect(work).rejects.toSatisfy(
    (error: unknown) => error instanceof ApiHttpException && error.getStatus() === status,
  );
}

describe("PlatformOperatorService", () => {
  it("denies an unauthenticated request", async () => {
    await expectStatus(harness({ authenticated: null }).service.requireOperator(request()), 401);
  });

  it("denies an ordinary user even if that user could be a workspace owner/admin", async () => {
    await expectStatus(
      harness({
        authenticated: principal,
        row: { isPlatformOperator: false },
      }).service.requireOperator(request()),
      403,
    );
  });

  it("allows only the database-authoritative platform boolean", async () => {
    await expect(
      harness({
        authenticated: principal,
        row: { isPlatformOperator: true },
      }).service.requireOperator(request()),
    ).resolves.toEqual(principal);
  });

  it("treats a stale session whose user was deleted as unauthenticated", async () => {
    await expectStatus(
      harness({ authenticated: principal }).service.requireOperator(request()),
      401,
    );
  });

  it("returns a generic unavailable response for auth/database outages", async () => {
    await expectStatus(harness({ available: false }).service.requireOperator(request()), 503);
    await expectStatus(
      harness({ authenticated: principal, selectFailure: true }).service.requireOperator(request()),
      503,
    );
  });
});
