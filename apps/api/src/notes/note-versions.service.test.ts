import { describe, expect, it, vi } from "vitest";

import { createTenantContext, TenantContextService } from "../tenant";

import { NoteVersionsService } from "./note-versions.service";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "30000000-0000-4000-8000-000000000002";
const noteId = "30000000-0000-4000-8500-000000000003";
const userId = "30000000-0000-4000-8000-000000000004";

/**
 * Run `fn` inside an active tenant context at `workspaceId`. The context is
 * callback-bounded (AsyncLocalStorage), so the service's `get()` only sees the
 * workspace while `fn` is on the stack — mirroring how request/job boundaries
 * establish scope in production.
 */
function inWorkspace<T>(tenant: TenantContextService, workspaceId: string, fn: () => T): T {
  return tenant.run(createTenantContext({ workspaceId, userId }), fn);
}

function serviceWith(): {
  readonly tenant: TenantContextService;
  readonly service: NoteVersionsService;
} {
  const tenant = new TenantContextService();
  return { tenant, service: new NoteVersionsService(tenant) };
}

describe("NoteVersionsService.recordAcceptedState", () => {
  it("writes one immutable snapshot of the accepted post-save state", async () => {
    const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: noteId }]) }) }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return Promise.resolve();
        },
      }),
    };
    const { tenant, service } = serviceWith();

    await inWorkspace(tenant, workspaceId, () =>
      service.recordAcceptedState(tx as never, {
        noteId,
        workspaceId,
        version: 3,
        title: "Launch overview",
        content: { type: "doc", content: [] },
        contentPlain: "Launch overview",
        createdById: userId,
      }),
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toMatchObject({
      noteId,
      version: 3,
      title: "Launch overview",
      content: { type: "doc", content: [] },
      contentPlain: "Launch overview",
      createdById: userId,
    });
    // The accepted-state snapshot deliberately carries no id (DB defaults it)
    // and no createdAt (defaultNow), proving it is append-only metadata.
    expect(inserts[0]?.values).not.toHaveProperty("id");
    expect(inserts[0]?.values).not.toHaveProperty("createdAt");
  });

  it("rejects a workspace id that disagrees with the active tenant context", async () => {
    const { tenant, service } = serviceWith();
    await expect(
      inWorkspace(tenant, workspaceId, () =>
        service.recordAcceptedState({} as never, {
          noteId,
          workspaceId: otherWorkspaceId,
          version: 1,
          title: "x",
          content: {},
          contentPlain: "",
          createdById: userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "tenant.workspace_mismatch" });
  });

  it("rejects when no tenant context is active at all", async () => {
    const { service } = serviceWith();
    await expect(
      service.recordAcceptedState({} as never, {
        noteId,
        workspaceId,
        version: 1,
        title: "x",
        content: {},
        contentPlain: "",
        createdById: userId,
      }),
    ).rejects.toMatchObject({ code: "tenant.no_active_context" });
  });

  it("surfaces a duplicate (note_id, version) as the unique-index violation (no upsert)", async () => {
    // A duplicate accepted state for the same version is a caller bug. There is
    // intentionally no upsert: the constraint violation rolls the transaction
    // back rather than silently overwriting immutable history.
    const insertError = new Error("unique constraint note_versions_note_version_unique");
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: noteId }]) }) }),
      }),
      insert: () => ({
        values: () => Promise.reject(insertError),
      }),
    };
    const { tenant, service } = serviceWith();
    await expect(
      inWorkspace(tenant, workspaceId, () =>
        service.recordAcceptedState(tx as never, {
          noteId,
          workspaceId,
          version: 3,
          title: "dup",
          content: {},
          contentPlain: "",
          createdById: userId,
        }),
      ),
    ).rejects.toBe(insertError);
  });
  it("rejects a note id whose parent is not in the active workspace before insert", async () => {
    const insert = vi.fn();
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      insert,
    };
    const { tenant, service } = serviceWith();
    await expect(
      inWorkspace(tenant, workspaceId, () =>
        service.recordAcceptedState(tx as never, {
          noteId,
          workspaceId,
          version: 1,
          title: "foreign",
          content: {},
          contentPlain: "",
          createdById: userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "tenant.workspace_mismatch" });
    expect(insert).not.toHaveBeenCalled();
  });
});
