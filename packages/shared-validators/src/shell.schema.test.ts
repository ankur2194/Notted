import { describe, expect, it } from "vitest";

import {
  notificationListQuerySchema,
  notificationReadStateSchema,
  shellBootstrapQuerySchema,
} from "./shell.schema";

describe("shell and notification contracts", () => {
  it("accepts only bounded list pagination and explicit unread filters", () => {
    expect(
      notificationListQuerySchema.parse({ page: "2", limit: "50", unreadOnly: "true" }),
    ).toEqual({
      page: 2,
      limit: 50,
      unreadOnly: true,
    });
    expect(notificationListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ page: "10001" }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ unreadOnly: "yes" }).success).toBe(false);
  });

  it("rejects guessed non-UUID workspace selectors and unknown read-state fields", () => {
    expect(shellBootstrapQuerySchema.safeParse({ workspaceId: "guessed" }).success).toBe(false);
    expect(
      notificationReadStateSchema.safeParse({ isRead: true, recipientId: "forged" }).success,
    ).toBe(false);
  });
});
