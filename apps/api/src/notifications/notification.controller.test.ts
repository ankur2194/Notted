import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";

import { NotificationController } from "./notification.controller";

import type { NotificationService } from "./notification.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "10000000-0000-4000-8000-000000000001";
const notificationId = "25000000-0000-4000-8000-000000000001";

function request(): Request {
  const value = {
    params: { workspaceId: "20000000-0000-4000-8000-000000000001" },
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

describe("NotificationController", () => {
  it("uses only the authenticated recipient and bounded parsed pagination", async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [], page: 2, limit: 10, hasMore: false, unreadCount: 0 });
    const controller = new NotificationController(
      { list } as unknown as NotificationService,
      {} as AuthService,
    );

    await controller.list(request(), { page: "2", limit: "10", unreadOnly: "true" });
    expect(list).toHaveBeenCalledWith({
      recipientUserId: userId,
      page: 2,
      limit: 10,
      unreadOnly: true,
    });
  });

  it("rejects forged recipient fields and checks mutation origin", () => {
    const assertTrustedMutationOrigin = vi.fn();
    const controller = new NotificationController(
      {} as NotificationService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );
    expect(() =>
      controller.setReadState(request(), notificationId, {
        isRead: true,
        recipientUserId: "forged",
      }),
    ).toThrow("The request is invalid.");
    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
  });
});
