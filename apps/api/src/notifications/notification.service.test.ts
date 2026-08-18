import { describe, expect, it, vi } from "vitest";

import { emailDeliveries, users } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { NotificationService } from "./notification.service";

import type { DatabaseService } from "../database/database.service";

const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";

interface PreferenceHarness {
  readonly service: NotificationService;
  readonly tenant: TenantContextService;
  readonly inserts: Record<string, unknown>[];
  readonly deletes: unknown[];
}

/**
 * Fake transaction for the sentinel path. `existingSentinel` decides whether the
 * "is it already suppressed?" lookup finds a row, which is the only branch that
 * separates a first "off" from a repeated one.
 */
function preferenceHarness(existingSentinel: boolean): PreferenceHarness {
  const inserts: Record<string, unknown>[] = [];
  const deletes: unknown[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              table === users
                ? [{ email: "  Ada@Example.TEST " }]
                : existingSentinel
                  ? [{ id: "sentinel" }]
                  : [],
            ),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, ...values });
        return Promise.resolve(undefined);
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        deletes.push(table);
        return Promise.resolve(undefined);
      },
    }),
  };
  const tenant = new TenantContextService();
  const database = {
    // `getEmailPreference` reads outside a transaction (it writes nothing), so
    // the fake has to serve both entry points off the same statement builder —
    // otherwise the read path would be exercised against a different fake than
    // the write path, which is exactly the drift these tests exist to catch.
    db: tx,
    transaction: <T>(work: (value: typeof tx) => Promise<T>) => work(tx),
  } as unknown as DatabaseService;
  return { service: new NotificationService(database, tenant), tenant, inserts, deletes };
}

function inWorkspace<T>(tenant: TenantContextService, fn: () => Promise<T>): Promise<T> {
  return tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: USER_ID }), fn);
}

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

  it("switching mention email off writes exactly one workspace-scoped sentinel row", async () => {
    const harness = preferenceHarness(false);
    await expect(
      inWorkspace(harness.tenant, () =>
        harness.service.setEmailPreference({ recipientUserId: USER_ID, mentionEmail: false }),
      ),
    ).resolves.toEqual({ mentionEmail: false });

    expect(harness.inserts).toHaveLength(1);
    expect(harness.inserts[0]).toMatchObject({
      table: emailDeliveries,
      workspaceId: WORKSPACE_ID,
      // Resolved from `users`, never from the request, and normalised so
      // `isSuppressed` matches it.
      recipient: "ada@example.test",
      templateKey: "mention",
      status: "suppressed",
      relatedEntityType: "unsubscribe",
      relatedEntityId: USER_ID,
    });
    expect(harness.deletes).toHaveLength(0);
  });

  it("switching mention email off twice does not pile up a second sentinel row", async () => {
    const harness = preferenceHarness(true);
    await inWorkspace(harness.tenant, () =>
      harness.service.setEmailPreference({ recipientUserId: USER_ID, mentionEmail: false }),
    );
    expect(harness.inserts).toHaveLength(0);
  });

  it("switching mention email back on deletes the sentinel row", async () => {
    const harness = preferenceHarness(true);
    await expect(
      inWorkspace(harness.tenant, () =>
        harness.service.setEmailPreference({ recipientUserId: USER_ID, mentionEmail: true }),
      ),
    ).resolves.toEqual({ mentionEmail: true });
    expect(harness.deletes).toEqual([emailDeliveries]);
    expect(harness.inserts).toHaveLength(0);
  });

  it("reports mention email ON when no sentinel row exists", async () => {
    // Opt-OUT, not opt-in: a member who never touched the toggle still gets mail.
    const harness = preferenceHarness(false);
    await expect(
      inWorkspace(harness.tenant, () =>
        harness.service.getEmailPreference({ recipientUserId: USER_ID }),
      ),
    ).resolves.toEqual({ mentionEmail: true });
    expect(harness.inserts).toHaveLength(0);
    expect(harness.deletes).toHaveLength(0);
  });

  it("reports mention email OFF when the sentinel row exists, and writes nothing", async () => {
    const harness = preferenceHarness(true);
    await expect(
      inWorkspace(harness.tenant, () =>
        harness.service.getEmailPreference({ recipientUserId: USER_ID }),
      ),
    ).resolves.toEqual({ mentionEmail: false });
    expect(harness.inserts).toHaveLength(0);
    expect(harness.deletes).toHaveLength(0);
  });

  it("denies the preference read before SQL when no tenant context is active", async () => {
    const harness = preferenceHarness(false);
    await expect(
      harness.service.getEmailPreference({ recipientUserId: USER_ID }),
    ).rejects.toMatchObject({ code: "tenant.no_active_context" });
  });

  it("denies the preference toggle before SQL when no tenant context is active", async () => {
    const harness = preferenceHarness(false);
    await expect(
      harness.service.setEmailPreference({ recipientUserId: USER_ID, mentionEmail: false }),
    ).rejects.toMatchObject({ code: "tenant.no_active_context" });
    expect(harness.inserts).toHaveLength(0);
  });
});
