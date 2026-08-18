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

  it("reads the email preference for the authenticated caller only, with no origin check", async () => {
    const assertTrustedMutationOrigin = vi.fn();
    const getEmailPreference = vi.fn().mockResolvedValue({ mentionEmail: true });
    const controller = new NotificationController(
      { getEmailPreference } as unknown as NotificationService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    await expect(controller.getEmailPreference(request())).resolves.toEqual({ mentionEmail: true });
    // A GET mutates nothing, so it must NOT be gated on the mutation-origin
    // check — doing so would make the toggle unreadable from a plain navigation.
    expect(assertTrustedMutationOrigin).not.toHaveBeenCalled();
    // The recipient is the authenticated id, never anything from the request.
    expect(getEmailPreference).toHaveBeenCalledWith({ recipientUserId: userId });
  });

  it("passes only the authenticated recipient to the email preference toggle", async () => {
    const assertTrustedMutationOrigin = vi.fn();
    const setEmailPreference = vi.fn().mockResolvedValue({ mentionEmail: false });
    const controller = new NotificationController(
      { setEmailPreference } as unknown as NotificationService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    await expect(
      controller.setEmailPreference(request(), { mentionEmail: false }),
    ).resolves.toEqual({ mentionEmail: false });
    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(setEmailPreference).toHaveBeenCalledWith({
      recipientUserId: userId,
      mentionEmail: false,
    });
  });

  it("rejects a malformed email preference body as a validation error", () => {
    const setEmailPreference = vi.fn();
    const controller = new NotificationController(
      { setEmailPreference } as unknown as NotificationService,
      { assertTrustedMutationOrigin: vi.fn() } as unknown as AuthService,
    );
    expect(() => controller.setEmailPreference(request(), { mentionEmail: "no" })).toThrow(
      "The request is invalid.",
    );
    expect(setEmailPreference).not.toHaveBeenCalled();
  });

  it("rejects an untrusted mutation origin before touching the service", () => {
    const setEmailPreference = vi.fn();
    const controller = new NotificationController(
      { setEmailPreference } as unknown as NotificationService,
      {
        assertTrustedMutationOrigin: vi.fn(() => {
          throw new Error("The request origin is not allowed.");
        }),
      } as unknown as AuthService,
    );
    expect(() => controller.setEmailPreference(request(), { mentionEmail: true })).toThrow(
      "The request origin is not allowed.",
    );
    expect(setEmailPreference).not.toHaveBeenCalled();
  });
});
