import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail } from "@notted/shared-types";

import { createWorkspace, updateWorkspace } from "@/lib/workspaces/requests";

const workspace = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Acme Design",
  slug: "acme-design",
  description: null,
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "letter" },
  storageLimitBytes: null,
  createdById: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceDetail;

describe("workspace requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends and validates the selected default page size while creating", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ workspace, slug: workspace.slug }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await createWorkspace(
      {
        name: workspace.name,
        slug: workspace.slug,
        description: null,
        settings: { defaultPageSize: "letter" },
      },
      "workspace-create-00000001",
    );

    expect(result).toEqual({ ok: true, data: { workspace, slug: workspace.slug } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("workspace-create-00000001");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: workspace.name,
      slug: workspace.slug,
      description: null,
      settings: { defaultPageSize: "letter" },
    });
  });

  it("preserves the nested settings object in the PATCH body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ workspace }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await updateWorkspace(workspace.id, {
      settings: { defaultPageSize: "letter" },
    });

    expect(result).toEqual({ ok: true, data: { workspace } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: { defaultPageSize: "letter" },
    });
  });
});
