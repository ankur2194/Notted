import { describe, expect, it, vi } from "vitest";

import { TenantContextService } from "../tenant";

import { NotificationService } from "./notification.service";

import type { DatabaseService } from "../database/database.service";

describe("NotificationService", () => {
  it("denies before SQL when no tenant context is active", async () => {
    const select = vi.fn();
    const service = new NotificationService(
      { db: { select } } as unknown as DatabaseService,
      new TenantContextService(),
    );
    await expect(
      service.list({
        recipientUserId: "10000000-0000-4000-8000-000000000001",
        page: 1,
        limit: 20,
        unreadOnly: false,
      }),
    ).rejects.toMatchObject({ code: "tenant.no_active_context" });
    expect(select).not.toHaveBeenCalled();
  });
});
