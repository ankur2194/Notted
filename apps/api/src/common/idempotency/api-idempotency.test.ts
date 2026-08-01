import { describe, expect, it } from "vitest";

import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  requireIdempotencyKey,
} from "./api-idempotency";

import type { Request } from "express";

function request(value: string | undefined): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "idempotency-key" ? value : undefined),
  } as unknown as Request;
}

describe("API idempotency", () => {
  it("requires a bounded opaque header and persists only its hash identity", () => {
    const key = requireIdempotencyKey(request("workspace-create-00000001"));
    const identity = createApiIdempotencyIdentity({
      actorUserId: "10000000-0000-4000-8000-000000000001",
      operation: "workspace.create",
      key,
      payload: { name: "Alpha" },
    });
    expect(identity.keyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(identity.keyHash).not.toContain(key);
    expect(() => requireIdempotencyKey(request(undefined))).toThrow(
      "A valid Idempotency-Key header is required.",
    );
  });

  it("rejects reuse of one key with a different payload", () => {
    const identity = createApiIdempotencyIdentity({
      actorUserId: "10000000-0000-4000-8000-000000000001",
      operation: "workspace.create",
      key: "workspace-create-00000001",
      payload: { name: "Alpha" },
    });
    expect(() =>
      assertIdempotencyPayload(
        { resourceId: "20000000-0000-4000-8000-000000000001", payloadHash: "different" },
        identity,
      ),
    ).toThrow("already used for a different request");
  });
});
