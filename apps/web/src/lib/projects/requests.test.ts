import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectMutationProject } from "@notted/shared-types";

import { createProject, updateProject } from "@/lib/projects/requests";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const project = {
  id: "30000000-0000-4000-8000-000000000002",
  workspaceId,
  name: "Launch",
  description: null,
  coverImageUrl: null,
  color: "#3b82f6",
  status: "active",
  isArchived: false,
  isRestricted: false,
  dueAt: null,
  createdById: "30000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies ProjectMutationProject;

describe("project mutation requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends a stable caller-owned idempotency key and validates create output", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ project }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      createProject(workspaceId, { name: "Launch" }, "submission-key-0001"),
    ).resolves.toEqual({ ok: true, data: { project } });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "submission-key-0001",
    );
  });

  it.each([
    [400, "invalid"],
    [403, "forbidden-or-not-found"],
    [404, "forbidden-or-not-found"],
    [409, "conflict"],
    [503, "unavailable"],
  ] as const)("maps status %s to %s", async (status, kind) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(updateProject(workspaceId, project.id, { name: "Renamed" })).resolves.toEqual({
      ok: false,
      kind,
    });
  });
});
