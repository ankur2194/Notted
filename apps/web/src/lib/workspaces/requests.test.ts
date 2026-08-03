import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail } from "@notted/shared-types";

import {
  createWorkspace,
  deleteWorkspace,
  suggestSlugFromName,
  updateWorkspace,
} from "@/lib/workspaces/requests";

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

describe("workspace request failure mapping", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * Conflict is kept apart from connectivity failure on purpose: a taken slug
   * or domain is something the user can fix in the form, while a network error
   * is only worth retrying. Collapsing the two would leave the settings screen
   * showing "try again" for a name that will never be accepted.
   */
  it.each([
    [400, "invalid"],
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "forbidden"],
    [409, "conflict"],
    [422, "invalid"],
    [500, "network"],
    [503, "network"],
  ] as const)("maps a %s response to %s", async (status, kind) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(updateWorkspace(workspace.id, { name: "Renamed" })).resolves.toEqual({
      ok: false,
      kind,
    });
  });

  it("treats a response that does not match the contract as invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ workspace: { id: workspace.id } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(updateWorkspace(workspace.id, { name: "Renamed" })).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("treats a thrown request as a network failure", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(updateWorkspace(workspace.id, { name: "Renamed" })).resolves.toEqual({
      ok: false,
      kind: "network",
    });
  });

  it.each([
    ["a forged workspace id", () => updateWorkspace("forged", { name: "Renamed" })],
    ["an empty update", () => updateWorkspace(workspace.id, {})],
    [
      "a name that exceeds the contract",
      () => updateWorkspace(workspace.id, { name: "x".repeat(256) }),
    ],
    ["a create body with no name", () => createWorkspace({ slug: "acme" } as never, "key-0001")],
  ])("refuses %s before the network boundary", async (_label, invoke) => {
    await expect(invoke()).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Deleting a workspace is unrecoverable, so the contract requires an explicit
   * `confirm: true` literal. A caller that omits it never reaches the API.
   */
  it("requires explicit confirmation to delete", async () => {
    await expect(deleteWorkspace(workspace.id, {} as never)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: workspace.id, deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      deleteWorkspace(workspace.id, { confirm: true, expectedName: workspace.name }),
    ).resolves.toEqual({ ok: true, data: { id: workspace.id, deleted: true } });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({
      confirm: true,
      expectedName: workspace.name,
    });
  });
});

describe("slug suggestion", () => {
  it.each([
    ["Acme Design", "acme-design"],
    ["  Acme   Design  ", "acme-design"],
    ["ACME/Design", "acme-design"],
    ["Ünïcødé Name", "n-c-d-name"],
    ["--leading and trailing--", "leading-and-trailing"],
    ["2026 Roadmap", "2026-roadmap"],
  ])("coerces %s to %s", (name, expected) => {
    expect(suggestSlugFromName(name)).toBe(expected);
  });

  it("leaves an unusable name empty for the shared schema to reject", () => {
    expect(suggestSlugFromName("")).toBe("");
    expect(suggestSlugFromName("///")).toBe("");
  });

  /**
   * The slug column is bounded, and truncating mid-word can leave a trailing
   * hyphen that the shared slug pattern rejects. The suffix is stripped after
   * the cut, not before.
   */
  it("bounds the slug and never leaves a trailing hyphen after truncation", () => {
    const suggestion = suggestSlugFromName(`${"a".repeat(63)} tail`);

    expect(suggestion).toHaveLength(63);
    expect(suggestion.endsWith("-")).toBe(false);
  });
});
